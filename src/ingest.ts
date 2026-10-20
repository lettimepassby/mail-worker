import PostalMime, { type Address, type Email, type Header } from 'postal-mime';
import type { Env } from './env';
import { extractCode, extractLinks } from './extract';
import { notifyNewMail, type NotifyMessage } from './notify';
import { publishMail } from './realtime';
import { attachmentKey, bodyKey, rawKey, type StoredBody } from './storage';
import { collapseWhitespace, htmlToText } from './util';

const SNIPPET_LENGTH = 200;
// Kept small: the trigram index is several times the text size and D1 Free caps a database at 500 MB.
const INDEX_BODY_LENGTH = 4_000;
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
  const subject = collapseWhitespace(email.subject ?? '');
  const code = extractCode(subject, text);
  const links = extractLinks(email.html ?? null, email.text ?? null)
    .filter((l) => l.primary)
    .map((l) => ({ url: l.url.slice(0, 2000), text: l.text.slice(0, 80) }));

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
  const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
  await Promise.all([
    env.BUCKET.put(bodyKey(prefix), bodyBytes, { httpMetadata: { contentType: 'application/json' } }),
    ...attachments.map((a) =>
      env.BUCKET.put(attachmentKey(prefix, a.idx), a.content, { httpMetadata: { contentType: a.mime } }),
    ),
  ]);
  const extraBytes = bodyBytes.byteLength + attachments.reduce((sum, a) => sum + a.content.byteLength, 0);

  const sender = from ? `${from.name} ${from.address}` : '';
  const recipients = [...to, ...cc].map((m) => `${m.name} ${m.address}`).join(' ');
  const db = env.DB;
  const now = Date.now();

  // Few, set-based statements: the Free plan allows 50 D1 queries per invocation.
  await db.batch([
    // Counter first, as a delta against the previous value, so a re-parse doesn't double count.
    db
      .prepare("UPDATE counters SET value = value + ? - (SELECT r2_bytes - size FROM messages WHERE id = ?) WHERE key = 'r2_bytes'")
      .bind(extraBytes, id),
    db
      .prepare(
        `UPDATE messages SET
           from_addr = ?, from_name = ?, to_json = ?, cc_json = ?, reply_to = ?,
           subject = ?, snippet = ?, message_id_hdr = ?, sent_at = ?, attachment_count = ?,
           spf = ?, dkim = ?, dmarc = ?, verify_code = ?, links_json = ?, r2_bytes = size + ?,
           -- First successful parse only: DMARC failures go to spam.
           folder_changed_at = CASE WHEN status = 'pending' AND ? = 'fail' AND folder = 'inbox' THEN ? ELSE folder_changed_at END,
           folder = CASE WHEN status = 'pending' AND ? = 'fail' AND folder = 'inbox' THEN 'spam' ELSE folder END,
           status = 'ready', parse_error = NULL
         WHERE id = ?`,
      )
      .bind(
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
        code,
        JSON.stringify(links),
        extraBytes,
        auth.dmarc,
        now,
        auth.dmarc,
        id,
      ),
    db.prepare('DELETE FROM attachments WHERE message_id = ?').bind(id),
    db
      .prepare(
        `INSERT INTO attachments (message_id, idx, filename, mime, size, content_id, inline)
         SELECT ?1, j.value ->> '$.idx', j.value ->> '$.filename', j.value ->> '$.mime',
                j.value ->> '$.size', j.value ->> '$.cid', j.value ->> '$.inline'
           FROM json_each(?2) j`,
      )
      .bind(
        id,
        JSON.stringify(
          attachments.map((a) => ({
            idx: a.idx,
            filename: a.filename,
            mime: a.mime,
            size: a.content.byteLength,
            cid: a.contentId,
            inline: a.inline ? 1 : 0,
          })),
        ),
      ),
    db.prepare('DELETE FROM messages_fts WHERE rowid = ?').bind(id),
    db
      .prepare('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)')
      .bind(id, subject, sender, recipients, text.slice(0, INDEX_BODY_LENGTH)),
  ]);

  await afterIngest(env, id, {
    subject,
    fromName: from?.name ?? '',
    fromAddr: from?.address ?? '',
    snippet,
    body: text.slice(0, INDEX_BODY_LENGTH),
    code,
    links,
  });
}

/**
 * Runs once per message (guarded by the `notified` flag, so parse retries
 * never notify twice): pushes the event to open browser tabs and evaluates
 * Bark rules. Spam is shown live but never pushed to phones.
 */
async function afterIngest(env: Env, id: number, msg: Omit<NotifyMessage, 'id' | 'domain' | 'address'>) {
  const row = await env.DB.prepare(
    'UPDATE messages SET notified = 1 WHERE id = ? AND notified = 0 RETURNING domain, address, folder',
  )
    .bind(id)
    .first<{ domain: string; address: string; folder: string }>();
  if (!row) return;
  await publishMail(env, {
    type: 'mail',
    id,
    domain: row.domain,
    address: row.address,
    folder: row.folder,
    subject: msg.subject,
    from: msg.fromName || msg.fromAddr,
    code: msg.code,
  });
  if (row.folder === 'spam') return;
  try {
    await notifyNewMail(env, { ...msg, id, domain: row.domain, address: row.address });
  } catch (err) {
    console.error(`notify failed for message ${id}`, err);
  }
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
