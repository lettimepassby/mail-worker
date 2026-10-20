import type { Env } from './env';

export interface NotifyMessage {
  id: number;
  domain: string;
  address: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  snippet: string;
  body: string;
  code: string | null;
  links: { url: string; text: string }[];
}

export interface BarkTarget {
  id: number;
  name: string;
  server: string;
  device_key: string;
  enabled: number;
}

interface RuleRow {
  id: number;
  name: string;
  keywords: string;
  fields: string;
  scopes: string;
  require_code: number;
  target_ids: string;
}

export const DEFAULT_BARK_SERVER = 'https://api.day.app';

/**
 * Accepts what people usually paste from the Bark app — the full push URL
 * (https://api.day.app/KEY/...) — or a bare device key.
 */
export function parseBarkInput(input: string, server?: string): { server: string; key: string } | null {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      const key = url.pathname.split('/').filter(Boolean)[0];
      if (!key) return null;
      return { server: url.origin, key };
    } catch {
      return null;
    }
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(s)) return null;
  const base = (server?.trim() || DEFAULT_BARK_SERVER).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/i.test(base)) return null;
  return { server: base, key: s };
}

const parseList = (json: string): string[] => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

function ruleMatches(rule: RuleRow, msg: NotifyMessage): boolean {
  const scopes = parseList(rule.scopes).map((s) => s.toLowerCase());
  if (scopes.length > 0 && !scopes.includes(msg.domain) && !scopes.includes(msg.address)) return false;
  if (rule.require_code && !msg.code) return false;

  const keywords = parseList(rule.keywords)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  if (keywords.length === 0) return true;
  const fields = parseList(rule.fields);
  const haystack = [
    fields.includes('subject') ? msg.subject : '',
    fields.includes('from') ? `${msg.fromName} ${msg.fromAddr}` : '',
    fields.includes('body') ? msg.body : '',
  ]
    .join('\n')
    .toLowerCase();
  return keywords.some((k) => haystack.includes(k));
}

function barkPayload(env: Env, msg: NotifyMessage, ruleNames: string[]) {
  const sender = msg.fromName || msg.fromAddr;
  const primary = msg.links[0]?.url;
  const lines = [`${sender} → ${msg.address}`];
  if (msg.code) lines.push(`验证码：${msg.code}`);
  if (msg.snippet) lines.push(msg.snippet.slice(0, 160));
  const base = env.PUBLIC_URL?.replace(/\/+$/, '');
  return {
    title: msg.code ? `${msg.code} · ${msg.subject || '验证码'}` : msg.subject || '(无主题)',
    subtitle: ruleNames.join('、'),
    body: lines.join('\n'),
    group: msg.domain,
    // Tapping opens the message in the web inbox; the code (or main link) is put on the clipboard.
    url: base ? `${base}/mail/inbox/${msg.id}` : undefined,
    copy: msg.code ?? primary,
    autoCopy: msg.code ? '1' : undefined,
    level: msg.code ? 'timeSensitive' : 'active',
    isArchive: '1',
    icon: base ? `${base}/favicon.png` : undefined,
  };
}

export async function sendBark(target: Pick<BarkTarget, 'server' | 'device_key'>, payload: Record<string, unknown>) {
  const res = await fetch(`${target.server.replace(/\/+$/, '')}/${encodeURIComponent(target.device_key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  const body = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
  if (!res.ok || (body && body.code !== undefined && body.code !== 200)) {
    throw new Error(body?.message || `HTTP ${res.status}`);
  }
}

async function deliver(env: Env, target: BarkTarget, payload: Record<string, unknown>) {
  let error: string | null = null;
  try {
    await sendBark(target, payload);
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    console.error(`bark ${target.name} failed`, error);
  }
  await env.DB.prepare('UPDATE bark_targets SET last_sent_at = ?, last_error = ? WHERE id = ?')
    .bind(Date.now(), error, target.id)
    .run();
}

/** Evaluates notification rules for a newly parsed message and pushes to every matched Bark device once. */
export async function notifyNewMail(env: Env, msg: NotifyMessage) {
  const { results: rules } = await env.DB.prepare('SELECT * FROM notify_rules WHERE enabled = 1').all<RuleRow>();
  if (rules.length === 0) return;

  const matched = rules.filter((r) => ruleMatches(r, msg));
  if (matched.length === 0) return;
  const targetIds = new Set(matched.flatMap((r) => parseList(r.target_ids).map(Number)));
  const { results: targets } = await env.DB.prepare(
    'SELECT * FROM bark_targets WHERE enabled = 1 AND id IN (SELECT value FROM json_each(?))',
  )
    .bind(JSON.stringify([...targetIds]))
    .all<BarkTarget>();

  const payload = barkPayload(env, msg, matched.map((r) => r.name));
  await Promise.all(targets.map((t) => deliver(env, t, payload)));
}
