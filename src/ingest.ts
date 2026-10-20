import PostalMime, { type Address, type Email, type Header } from 'postal-mime';
import type { Env } from './env';
import { attachmentKey, bodyKey, rawKey, type StoredBody } from './storage';
import { collapseWhitespace, htmlToText } from './util';

const SNIPPET_LENGTH = 200;
const INDEX_BODY_LENGTH = 20_000;
export const MAX_PARSE_ATTEMPTS = 5;

interface Mailbox {
  name: string;
  address: string;
}

function flatten(list: Address[] | undefined): Mailbox[] {
  const out: Mailbox[] = [];
  for (const a of list ?? []) {
    if (a.group) out.push(...a.group.map((m) => ({ name: m.name, address: m.address.toLowerCase() })));
    else if (a.address) out.push({ name: a.name, address: a.address.toLowerCase() });
  }
  return out;
}

interface AuthResults {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

/**
 * Reads SPF/DKIM/DMARC verdicts from the Authentication-Results header that
 * Cloudflare's MX added. Headers from upstream hops are ignored since the
 * sender controls them.
 */
export function parseAuthResults(headers: Header[]): AuthResults {
  const header = headers.find(
    (h) =>
      (h.key === 'authentication-results' || h.key === 'arc-authentication-results') &&
      /cloudflare/i.test(h.value.split(';').slice(0, 2).join(';')),
  );
  const pick = (method: string) => header?.value.match(new RegExp(`\\b${method}=([a-z]+)`, 'i'))?.[1].toLowerCase() ?? null;
  return header ? { spf: pick('spf'), dkim: pick('dkim'), dmarc: pick('dmarc') } : { spf: null, dkim: null, dmarc: null };
}

function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Parses the stored raw message and fills in everything derived from it. */
export async function ingestMessage(env: Env, id: number, prefix: string, raw?: ArrayBuffer) {
  if (!raw) {
    const obj = await env.BUCKET.get(rawKey(prefix));
    if (!obj) throw new Error(`raw message missing: ${rawKey(prefix)}`);
    raw = await obj.arrayBuffer();
  }

  const email: Email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const from = flatten(email.from ? [email.from] : [])[0];
  const to = flatten(email.to);
  const cc = flatten(email.cc);
  const replyTo = flatten(email.replyTo)[0]?.address ?? '';
  const auth = parseAuthResults(email.headers);

  const text = email.text ?? (email.html ? htmlToText(email.html) : '');
  const snippet = collapseWhitespace(text).slice(0, SNIPPET_LENGTH);

  const attachments = email.attachments.map((a, idx) => {
    const content = typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content);
    return {
      idx,
      content,
      filename: a.filename ?? '',
      mime: (a.mimeType || 'application/octet-stream').toLowerCase(),
      contentId: a.contentId ? a.contentId.replace(/^<|>$/g, '') : null,
      inline: a.disposition === 'inline' || (!!a.contentId && !!a.related),
    };
  });

  const body: StoredBody = { html: email.html ?? null, text: email.text ?? null };
  await Promise.all([
    env.BUCKET.put(bodyKey(prefix), JSON.stringify(body), { httpMetadata: { contentType: 'application/json' } }),
    ...attachments.map((a) =>
      env.BUCKET.put(attachmentKey(prefix, a.idx), a.content, { httpMetadata: { contentType: a.mime } }),
    ),
  ]);

  const subject = collapseWhitespace(email.subject ?? '');
  const sender = from ? `${from.name} ${from.address}` : '';
  const recipients = [...to, ...cc].map((m) => `${m.name} ${m.address}`).join(' ');

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE messages SET
         from_addr = ?, from_name = ?, to_json = ?, cc_json = ?, reply_to = ?,
         subject = ?, snippet = ?, message_id_hdr = ?, sent_at = ?, attachment_count = ?,
         spf = ?, dkim = ?, dmarc = ?,
         -- First successful parse only: DMARC failures go to spam.
         folder = CASE WHEN status = 'pending' AND ? = 'fail' AND folder = 'inbox' THEN 'spam' ELSE folder END,
         status = 'ready', parse_error = NULL
       WHERE id = ?`,
    ).bind(
      from?.address ?? '',
      from?.name ?? '',
      JSON.stringify(to),
      JSON.stringify(cc),
      replyTo,
      subject,
      snippet,
      email.messageId ?? null,
      parseDate(email.date),
      attachments.length,
      auth.spf,
      auth.dkim,
      auth.dmarc,
      auth.dmarc,
      id,
    ),
    env.DB.prepare('DELETE FROM attachments WHERE message_id = ?').bind(id),
    ...attachments.map((a) =>
      env.DB.prepare(
        'INSERT INTO attachments (message_id, idx, filename, mime, size, content_id, inline) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, a.idx, a.filename, a.mime, a.content.byteLength, a.contentId, a.inline ? 1 : 0),
    ),
    env.DB.prepare('DELETE FROM messages_fts WHERE rowid = ?').bind(id),
    env.DB.prepare('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)').bind(
      id,
      subject,
      sender,
      recipients,
      text.slice(0, INDEX_BODY_LENGTH),
    ),
  ]);
}

/** Records a failed inline parse; the scheduled job retries until MAX_PARSE_ATTEMPTS. */
export async function recordParseFailure(env: Env, id: number, err: unknown, counted = false) {
  const message = err instanceof Error ? err.message : String(err);
  await env.DB.prepare(
    `UPDATE messages SET
       parse_attempts = parse_attempts + ?,
       parse_error = ?,
       status = CASE WHEN parse_attempts + ? >= ? THEN 'failed' ELSE status END
     WHERE id = ? AND status = 'pending'`,
  )
    .bind(counted ? 0 : 1, message.slice(0, 500), counted ? 0 : 1, MAX_PARSE_ATTEMPTS, id)
    .run();
}
