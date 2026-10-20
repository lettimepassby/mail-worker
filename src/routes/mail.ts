import { Hono, type Context } from 'hono';
import { scopeFor } from '../access';
import { requireUser } from '../auth';
import type { AppEnv, Env } from '../env';
import { sanitizeEmailHtml } from '../html';
import { attachmentKey, bodyKey, purgeMessages, rawKey, type StoredBody } from '../storage';
import { badRequest, hmac, notFound, parseIntParam, safeEqual } from '../util';

const PAGE_SIZE = 50;
const INLINE_URL_TTL = 6 * 3600 * 1000;

const FOLDERS = ['inbox', 'archive', 'spam', 'trash'] as const;
type Folder = (typeof FOLDERS)[number];
const isFolder = (v: unknown): v is Folder => FOLDERS.includes(v as Folder);

interface MessageRow {
  id: number;
  r2_prefix: string;
  domain: string;
  address: string;
  envelope_from: string;
  from_addr: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  reply_to: string;
  subject: string;
  snippet: string;
  message_id_hdr: string | null;
  sent_at: number | null;
  received_at: number;
  size: number;
  attachment_count: number;
  folder: Folder;
  is_read: number;
  is_starred: number;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  status: 'pending' | 'ready' | 'failed';
  parse_error: string | null;
}

const LIST_COLUMNS = `m.id, m.domain, m.address, m.from_addr, m.from_name, m.subject, m.snippet,
  m.received_at, m.sent_at, m.attachment_count, m.folder, m.is_read, m.is_starred, m.status`;

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Terms of 3+ characters go through the trigram FTS index (subject, sender,
 * recipients, body). Shorter terms (common for Chinese) fall back to LIKE on
 * subject and sender, which the trigram index can't serve.
 */
function searchClauses(q: string) {
  const where: string[] = [];
  const params: unknown[] = [];
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 8);
  const long = terms.filter((t) => [...t].length >= 3);
  const short = terms.filter((t) => [...t].length < 3);
  if (long.length > 0) {
    where.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
    params.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND '));
  }
  for (const t of short) {
    const like = `%${escapeLike(t)}%`;
    where.push(
      `(m.subject LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\' OR m.from_addr LIKE ? ESCAPE '\\' OR m.snippet LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like);
  }
  return { where, params };
}

async function loadMessage(c: Context<AppEnv>, id: number): Promise<MessageRow> {
  const scope = scopeFor(c.get('user'), 'm');
  const row = await c.env.DB.prepare(`SELECT m.* FROM messages m WHERE m.id = ? AND ${scope.sql}`)
    .bind(id, ...scope.params)
    .first<MessageRow>();
  if (!row) notFound('邮件不存在');
  return row;
}

function messageId(c: Context): number {
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) notFound('邮件不存在');
  return id;
}

async function inlineUrl(env: Env, id: number, idx: number): Promise<string> {
  const exp = Date.now() + INLINE_URL_TTL;
  const sig = await hmac(env.SESSION_SECRET, `${id}.${idx}.${exp}`);
  return `/api/inline/${id}/${idx}?exp=${exp}&sig=${sig}`;
}

function contentDisposition(kind: 'inline' | 'attachment', filename: string) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename || 'file')}`;
}

// Served from our own origin, so lock the response down regardless of its type.
const DOWNLOAD_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  'cache-control': 'private, max-age=300',
};

const isPreviewable = (mime: string) =>
  (mime.startsWith('image/') && mime !== 'image/svg+xml') || mime === 'application/pdf';

const mail = new Hono<AppEnv>();
mail.use('*', requireUser);

mail.get('/mailboxes', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const scopeA = scopeFor(user, 'a');
  const scopeM = scopeFor(user, 'm');
  const domainFilter =
    user.role === 'admin'
      ? { sql: '1 = 1', params: [] as unknown[] }
      : {
          sql: `(d.name IN (SELECT value FROM user_access WHERE user_id = ? AND kind = 'domain')
              OR d.name IN (SELECT a.domain FROM addresses a JOIN user_access ua
                              ON ua.user_id = ? AND ua.kind = 'address' AND ua.value = a.address))`,
          params: [user.id, user.id] as unknown[],
        };

  const [domains, addresses, unread] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT d.name, d.policy FROM domains d WHERE ${domainFilter.sql} ORDER BY d.name`).bind(...domainFilter.params),
    db
      .prepare(
        `SELECT a.address, a.domain, a.status, a.last_received_at FROM addresses a
          WHERE ${scopeA.sql} ORDER BY a.domain, a.last_received_at DESC`,
      )
      .bind(...scopeA.params),
    db
      .prepare(
        `SELECT m.address, m.folder, COUNT(*) AS n FROM messages m
          WHERE m.folder IN ('inbox', 'spam') AND m.is_read = 0 AND ${scopeM.sql}
          GROUP BY m.address, m.folder`,
      )
      .bind(...scopeM.params),
  ]);

  const inboxUnread = new Map<string, number>();
  const folders = { inbox: 0, spam: 0 };
  for (const r of unread.results) {
    const n = Number(r.n);
    if (r.folder === 'inbox') {
      inboxUnread.set(String(r.address), n);
      folders.inbox += n;
    } else folders.spam += n;
  }

  const byDomain = new Map<string, { address: string; status: string; unread: number; lastReceivedAt: number | null }[]>();
  for (const a of addresses.results) {
    const list = byDomain.get(String(a.domain)) ?? [];
    list.push({
      address: String(a.address),
      status: String(a.status),
      unread: inboxUnread.get(String(a.address)) ?? 0,
      lastReceivedAt: (a.last_received_at as number | null) ?? null,
    });
    byDomain.set(String(a.domain), list);
  }

  return c.json({
    folders,
    domains: domains.results.map((d) => {
      const list = byDomain.get(String(d.name)) ?? [];
      return {
        name: String(d.name),
        policy: String(d.policy),
        unread: list.reduce((s, a) => s + a.unread, 0),
        addresses: list,
      };
    }),
  });
});

mail.get('/messages', async (c) => {
  const user = c.get('user');
  const where: string[] = [];
  const params: unknown[] = [];

  const view = c.req.query('view') ?? 'inbox';
  if (isFolder(view)) {
    where.push('m.folder = ?');
    params.push(view);
  } else if (view === 'starred') {
    where.push("m.is_starred = 1 AND m.folder != 'trash'");
  } else if (view === 'all') {
    where.push("m.folder IN ('inbox', 'archive')");
  } else badRequest('未知视图');

  const scope = scopeFor(user, 'm');
  where.push(scope.sql);
  params.push(...scope.params);

  const domain = c.req.query('domain');
  if (domain) {
    where.push('m.domain = ?');
    params.push(domain.toLowerCase());
  }
  const address = c.req.query('address');
  if (address) {
    where.push('m.address = ?');
    params.push(address.toLowerCase());
  }
  if (c.req.query('unread') === '1') where.push('m.is_read = 0');

  const q = c.req.query('q')?.trim();
  if (q) {
    const s = searchClauses(q);
    where.push(...s.where);
    params.push(...s.params);
  }

  const cursor = c.req.query('cursor');
  if (cursor) {
    const [ts, id] = cursor.split('_').map(Number);
    if (!Number.isFinite(ts) || !Number.isFinite(id)) badRequest('cursor 无效');
    where.push('(m.received_at < ? OR (m.received_at = ? AND m.id < ?))');
    params.push(ts, ts, id);
  }

  const limit = Math.min(Math.max(parseIntParam(c.req.query('limit'), PAGE_SIZE), 1), 100);
  const { results } = await c.env.DB.prepare(
    `SELECT ${LIST_COLUMNS} FROM messages m WHERE ${where.join(' AND ')}
      ORDER BY m.received_at DESC, m.id DESC LIMIT ?`,
  )
    .bind(...params, limit + 1)
    .all<{ id: number; received_at: number; is_read: number; is_starred: number }>();

  const hasMore = results.length > limit;
  const items = results.slice(0, limit).map((r) => ({
    ...r,
    is_read: !!r.is_read,
    is_starred: !!r.is_starred,
  }));
  const last = items.at(-1);
  return c.json({ items, nextCursor: hasMore && last ? `${last.received_at}_${last.id}` : null });
});

mail.get('/messages/:id', async (c) => {
  const id = messageId(c);
  const row = await loadMessage(c, id);
  const { results: attachments } = await c.env.DB.prepare(
    'SELECT idx, filename, mime, size, content_id, inline FROM attachments WHERE message_id = ? ORDER BY idx',
  )
    .bind(id)
    .all<{ idx: number; filename: string; mime: string; size: number; content_id: string | null; inline: number }>();

  let html: string | null = null;
  let text: string | null = null;
  if (row.status === 'ready') {
    const obj = await c.env.BUCKET.get(bodyKey(row.r2_prefix));
    if (obj) {
      const body = await obj.json<StoredBody>();
      text = body.text;
      if (body.html) {
        const cids = new Map<string, string>();
        for (const a of attachments) {
          if (a.content_id) cids.set(a.content_id, await inlineUrl(c.env, id, a.idx));
        }
        html = await sanitizeEmailHtml(body.html, cids);
      }
    }
  }

  const { r2_prefix: _prefix, to_json, cc_json, is_read, is_starred, ...rest } = row;
  return c.json({
    message: {
      ...rest,
      to: JSON.parse(to_json),
      cc: JSON.parse(cc_json),
      is_read: !!is_read,
      is_starred: !!is_starred,
    },
    attachments: attachments.map((a) => ({ ...a, inline: !!a.inline, previewable: isPreviewable(a.mime) })),
    html,
    text,
  });
});

interface Patch {
  is_read?: boolean;
  is_starred?: boolean;
  folder?: Folder;
}

function patchSql(patch: Patch) {
  const set: string[] = [];
  const params: unknown[] = [];
  if (typeof patch.is_read === 'boolean') {
    set.push('is_read = ?');
    params.push(patch.is_read ? 1 : 0);
  }
  if (typeof patch.is_starred === 'boolean') {
    set.push('is_starred = ?');
    params.push(patch.is_starred ? 1 : 0);
  }
  if (patch.folder !== undefined) {
    if (!isFolder(patch.folder)) badRequest('未知文件夹');
    set.push('folder = ?', 'folder_changed_at = ?');
    params.push(patch.folder, Date.now());
  }
  if (set.length === 0) badRequest('没有可更新的字段');
  return { set: set.join(', '), params };
}

mail.patch('/messages/:id', async (c) => {
  const id = messageId(c);
  await loadMessage(c, id);
  const { set, params } = patchSql(await c.req.json<Patch>());
  await c.env.DB.prepare(`UPDATE messages SET ${set} WHERE id = ?`).bind(...params, id).run();
  return c.json({ ok: true });
});

const BATCH_ACTIONS: Record<string, Patch> = {
  read: { is_read: true },
  unread: { is_read: false },
  star: { is_starred: true },
  unstar: { is_starred: false },
  inbox: { folder: 'inbox' },
  archive: { folder: 'archive' },
  spam: { folder: 'spam' },
  trash: { folder: 'trash' },
};

mail.post('/messages/batch', async (c) => {
  const body = await c.req.json<{ ids?: unknown; action?: string }>();
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is number => Number.isSafeInteger(x)) : [];
  if (ids.length === 0 || ids.length > 500) badRequest('ids 需为 1-500 个');
  const scope = scopeFor(c.get('user'), 'm');
  const idList = JSON.stringify(ids);

  if (body.action === 'delete') {
    // Permanent delete is limited to trash and spam.
    const { results } = await c.env.DB.prepare(
      `SELECT m.id, m.r2_prefix, m.attachment_count FROM messages m
        WHERE m.id IN (SELECT value FROM json_each(?)) AND m.folder IN ('trash', 'spam') AND ${scope.sql}`,
    )
      .bind(idList, ...scope.params)
      .all<{ id: number; r2_prefix: string; attachment_count: number }>();
    await purgeMessages(c.env, results);
    return c.json({ ok: true, affected: results.length });
  }

  const patch = BATCH_ACTIONS[body.action ?? ''];
  if (!patch) badRequest('未知操作');
  const { set, params } = patchSql(patch);
  const res = await c.env.DB.prepare(
    `UPDATE messages SET ${set} WHERE id IN (
       SELECT m.id FROM messages m WHERE m.id IN (SELECT value FROM json_each(?)) AND ${scope.sql})`,
  )
    .bind(...params, idList, ...scope.params)
    .run();
  return c.json({ ok: true, affected: res.meta.changes });
});

mail.post('/messages/empty', async (c) => {
  const body = await c.req.json<{ folder?: string; domain?: string | null; address?: string | null }>();
  if (body.folder !== 'trash' && body.folder !== 'spam') badRequest('只能清空回收站或垃圾邮件');
  const scope = scopeFor(c.get('user'), 'm');
  const where = ['m.folder = ?', scope.sql];
  const params: unknown[] = [body.folder, ...scope.params];
  if (body.domain) {
    where.push('m.domain = ?');
    params.push(body.domain.toLowerCase());
  }
  if (body.address) {
    where.push('m.address = ?');
    params.push(body.address.toLowerCase());
  }
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.r2_prefix, m.attachment_count FROM messages m WHERE ${where.join(' AND ')} LIMIT 200`,
  )
    .bind(...params)
    .all<{ id: number; r2_prefix: string; attachment_count: number }>();
  await purgeMessages(c.env, results);
  return c.json({ ok: true, deleted: results.length, more: results.length === 200 });
});

mail.get('/messages/:id/raw', async (c) => {
  const id = messageId(c);
  const row = await loadMessage(c, id);
  const obj = await c.env.BUCKET.get(rawKey(row.r2_prefix));
  if (!obj) notFound('原始邮件不存在');
  const download = c.req.query('download') === '1';
  return new Response(obj.body, {
    headers: {
      ...DOWNLOAD_HEADERS,
      'content-type': download ? 'message/rfc822' : 'text/plain; charset=utf-8',
      'content-disposition': contentDisposition(download ? 'attachment' : 'inline', `message-${id}.eml`),
    },
  });
});

mail.get('/messages/:id/attachments/:idx', async (c) => {
  const id = messageId(c);
  const row = await loadMessage(c, id);
  const idx = Number(c.req.param('idx'));
  const att = await c.env.DB.prepare('SELECT filename, mime FROM attachments WHERE message_id = ? AND idx = ?')
    .bind(id, idx)
    .first<{ filename: string; mime: string }>();
  if (!att) notFound('附件不存在');
  const obj = await c.env.BUCKET.get(attachmentKey(row.r2_prefix, idx));
  if (!obj) notFound('附件不存在');
  const inline = c.req.query('inline') === '1' && isPreviewable(att.mime);
  return new Response(obj.body, {
    headers: {
      ...DOWNLOAD_HEADERS,
      'content-type': inline ? att.mime : 'application/octet-stream',
      'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', att.filename || `attachment-${idx}`),
    },
  });
});

/**
 * Inline (cid:) images. The email iframe is sandboxed, so these are authorised
 * by a short-lived HMAC signature instead of the session cookie.
 */
export const inline = new Hono<AppEnv>();

inline.get('/:id/:idx', async (c) => {
  const id = Number(c.req.param('id'));
  const idx = Number(c.req.param('idx'));
  const exp = Number(c.req.query('exp'));
  const sig = c.req.query('sig') ?? '';
  if (!Number.isFinite(exp) || exp < Date.now()) notFound();
  if (!safeEqual(sig, await hmac(c.env.SESSION_SECRET, `${id}.${idx}.${exp}`))) notFound();

  const row = await c.env.DB.prepare(
    `SELECT m.r2_prefix, a.mime FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE a.message_id = ? AND a.idx = ?`,
  )
    .bind(id, idx)
    .first<{ r2_prefix: string; mime: string }>();
  if (!row || !row.mime.startsWith('image/')) notFound();
  const obj = await c.env.BUCKET.get(attachmentKey(row.r2_prefix, idx));
  if (!obj) notFound();
  return new Response(obj.body, {
    headers: { ...DOWNLOAD_HEADERS, 'content-type': row.mime, 'cache-control': 'private, max-age=3600' },
  });
});

export default mail;
