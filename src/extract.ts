/**
 * Pulls the things people actually want out of transactional mail: the
 * verification code and the "click here to ..." links. Pure functions, no
 * runtime imports, so they can be unit-tested with plain Node.
 */

// Strong keywords: a code right next to one of these is almost certainly the code.
const STRONG_KEYWORDS = [
  '验证码', '校验码', '确认码', '动态码', '动态密码', '激活码', '安全码', '登录码', '认证码', '授权码', '一次性密码', '提取码', '口令',
  'verification code', 'verify code', 'security code', 'confirmation code', 'one-time code', 'one time code',
  'one-time password', 'one time password', 'otp', 'passcode', 'login code', 'log-in code', 'sign-in code',
  'sign in code', 'authentication code', 'auth code', 'access code', 'pin code', 'guard code', 'your code',
];
// A bare "code" also counts, but only when the candidate sits right next to it.
const WEAK_KEYWORDS = ['code', 'pin'];

const CANDIDATE_RE =
  /(?<![\w#¥$€£.\-/:@])([A-Z]{1,3}-\d{4,8}|\d{3}[ -]\d{3}|\d{4}[ -]\d{4}|[A-Z0-9]{4,8})(?![\w\-/:%@年月日元])(?!\.\d)/g;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KEYWORD_RE = new RegExp(
  [...STRONG_KEYWORDS, ...WEAK_KEYWORDS].map((k) => (/^[a-z]/i.test(k) ? `\\b${escapeRe(k)}\\b` : escapeRe(k))).join('|'),
  'gi',
);

function isPlausibleCode(raw: string): boolean {
  const s = raw.replace(/[ -]/g, '');
  if (!/\d/.test(s)) return false; // must contain a digit
  if (/^\d+$/.test(s)) {
    if (s.length === 4 && /^(19|20)\d\d$/.test(s)) return false; // looks like a year
    return s.length >= 4 && s.length <= 8;
  }
  // Mixed alphanumerics: uppercase only (the regex already requires it), 4-8 long, not a hex colour etc.
  return s.length >= 4 && s.length <= 9;
}

function candidates(text: string): { value: string; index: number }[] {
  const out: { value: string; index: number }[] = [];
  for (const m of text.matchAll(CANDIDATE_RE)) {
    if (isPlausibleCode(m[1])) out.push({ value: m[1], index: m.index! });
  }
  return out;
}

/** Returns the most likely verification code in `subject` + `body`, or null. */
export function extractCode(subject: string, body: string): string | null {
  for (const text of [subject, body.slice(0, 6000)]) {
    const flat = text.replace(/\s+/g, ' ');
    const cands = candidates(flat);
    if (cands.length === 0) continue;

    let best: { value: string; score: number } | null = null;
    for (const k of flat.matchAll(KEYWORD_RE)) {
      const strong = !WEAK_KEYWORDS.includes(k[0].toLowerCase());
      const start = k.index!;
      const end = start + k[0].length;
      const maxAfter = strong ? 40 : 15;
      const maxBefore = 30;
      for (const c of cands) {
        let distance: number;
        if (c.index >= end) distance = c.index - end;
        else if (c.index + c.value.length <= start) distance = start - (c.index + c.value.length) + 5; // prefer "keyword: code"
        else continue;
        if (distance > (c.index >= end ? maxAfter : maxBefore)) continue;
        const score = (strong ? 100 : 50) - distance;
        if (!best || score > best.score) best = { value: c.value, score };
      }
    }
    if (best) return /^\d{3,4}[ -]\d{3,4}$/.test(best.value) ? best.value.replace(/[ -]/g, '') : best.value;
  }
  return null;
}

export interface ExtractedLink {
  url: string;
  text: string;
  /** Looks like the thing the email wants you to click (verify, reset, sign in...). */
  primary: boolean;
}

const ACTION_TEXT_RE = new RegExp(
  [
    '验证|确认|激活|重置|找回|登录|登陆|点击|点此|查看|立即|完成|开始|下载|加入|接受|同意|授权|绑定|注册|继续|打开|领取|支付|付款',
    // English words need boundaries ("review" is not "view").
    '\\b(verify|confirm|activate|reset|sign ?in|log ?in|magic link|continue|get started|accept|join|download|view|open|approve|authori[sz]e|complete|validate|click|set ?up|create|claim|pay)\\b',
  ].join('|'),
  'i',
);
const ACTION_URL_RE = /verif|confirm|activat|reset|password|token|magic|login|signin|sign-in|auth|invite|accept|onboard|callback|ticket|otp/i;
const NOISE_RE =
  /unsubscribe|退订|取消订阅|订阅设置|manage (your )?(email )?preferences|email preferences|privacy|隐私|terms|条款|帮助中心|help center|contact us|联系我们|view (it )?in (your )?browser|在浏览器中查看/i;
const NOISE_HOST_RE =
  /(^|\.)(facebook|twitter|x|instagram|linkedin|youtube|weibo|tiktok|pinterest|discord|reddit)\.com$|(^|\.)t\.me$|apps\.apple\.com|play\.google\.com/i;

const MAX_LINKS = 100;
const URL_RE = /https?:\/\/[^\s<>"'（）【】「」]+/gi;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, '&');
}

function cleanUrl(raw: string): string | null {
  const url = decodeEntities(raw.trim()).replace(/[)\]）】>。，,.!?;:'"]+$/, '');
  if (!/^https?:\/\//i.test(url) || url.length > 4000) return null;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

function score(url: string, text: string, context: string): number {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return -1;
  }
  if (NOISE_RE.test(text) || NOISE_RE.test(url) || NOISE_HOST_RE.test(host)) return -1;
  let s = 0;
  if (ACTION_TEXT_RE.test(text)) s += 5;
  if (ACTION_TEXT_RE.test(context.replace(URL_RE, ' '))) s += 2;
  if (ACTION_URL_RE.test(url)) s += 3;
  if (text && text.length <= 40 && text !== url) s += 1;
  return s;
}

const ANCHOR_RE = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;

/** All http(s) links in the message (deduplicated), best candidates flagged `primary`. */
export function extractLinks(html: string | null, text: string | null): ExtractedLink[] {
  const found = new Map<string, { url: string; text: string; score: number; order: number }>();
  const add = (url: string | null, label: string, context: string) => {
    if (!url) return;
    const s = score(url, label, context);
    const prev = found.get(url);
    if (!prev) found.set(url, { url, text: label, score: s, order: found.size });
    else if (s > prev.score || (!prev.text && label)) found.set(url, { ...prev, text: label || prev.text, score: Math.max(s, prev.score) });
  };

  if (html) {
    for (const m of html.matchAll(ANCHOR_RE)) {
      if (found.size >= MAX_LINKS) break;
      const inner = m[4];
      let label = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (!label) label = decodeEntities(inner.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? '').trim();
      const before = decodeEntities(html.slice(Math.max(0, m.index! - 300), m.index!).replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .slice(-40);
      add(cleanUrl(m[1] ?? m[2] ?? m[3] ?? ''), label.slice(0, 120), before);
    }
  }
  if (text) {
    for (const m of text.matchAll(URL_RE)) {
      if (found.size >= MAX_LINKS) break;
      const before = text.slice(Math.max(0, m.index! - 40), m.index!).replace(/\s+/g, ' ');
      add(cleanUrl(m[0]), '', before);
    }
  }

  const all = [...found.values()];
  const primary = new Set(
    all
      .filter((l) => l.score >= 4)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, 3)
      .map((l) => l.url),
  );
  return all.sort((a, b) => a.order - b.order).map((l) => ({ url: l.url, text: l.text, primary: primary.has(l.url) }));
}
