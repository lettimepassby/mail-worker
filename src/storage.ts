/** R2 layout for one message: {prefix}/raw.eml, {prefix}/body.json, {prefix}/att/{idx}. */

export function newPrefix(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `mail/${y}/${m}/${d}/${crypto.randomUUID()}`;
}

export const rawKey = (prefix: string) => `${prefix}/raw.eml`;
export const bodyKey = (prefix: string) => `${prefix}/body.json`;
export const attachmentKey = (prefix: string, idx: number) => `${prefix}/att/${idx}`;

export interface StoredBody {
  html: string | null;
  text: string | null;
}

export function messageKeys(prefix: string, attachmentCount: number): string[] {
  const keys = [rawKey(prefix), bodyKey(prefix)];
  for (let i = 0; i < attachmentCount; i++) keys.push(attachmentKey(prefix, i));
  return keys;
}

interface PurgeRow {
  id: number;
  r2_prefix: string;
  attachment_count: number;
}

/** Permanently deletes messages: R2 objects, attachments, search index and rows. */
export async function purgeMessages(env: { DB: D1Database; BUCKET: R2Bucket }, rows: PurgeRow[]) {
  if (rows.length === 0) return;
  const keys = rows.flatMap((r) => messageKeys(r.r2_prefix, r.attachment_count));
  // R2 accepts up to 1000 keys per delete call.
  for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
  const stmts = rows.flatMap((r) => [
    env.DB.prepare('DELETE FROM messages_fts WHERE rowid = ?').bind(r.id),
    env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(r.id),
  ]);
  await env.DB.batch(stmts);
}
