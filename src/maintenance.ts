import type { Env } from './env';
import { ingestMessage, MAX_PARSE_ATTEMPTS, recordParseFailure } from './ingest';
import { purgeMessages } from './storage';

const DAY = 24 * 3600 * 1000;

// Small batches: on the Free plan the whole cron run shares a 10ms CPU budget.
const RETRY_BATCH = 3;

/**
 * Re-parses messages still pending a couple of minutes after arrival. Each
 * attempt is counted before parsing starts, so a message that keeps getting
 * the invocation killed (CPU limit) still runs out of attempts and is marked
 * failed instead of blocking the queue forever.
 */
async function retryPending(env: Env) {
  await env.DB.prepare(
    `UPDATE messages SET status = 'failed', parse_error = COALESCE(parse_error, '解析超出资源限制，请下载原文查看')
      WHERE status = 'pending' AND parse_attempts >= ?`,
  )
    .bind(MAX_PARSE_ATTEMPTS)
    .run();

  const { results } = await env.DB.prepare(
    `SELECT id, r2_prefix FROM messages
      WHERE status = 'pending' AND received_at < ? AND parse_attempts < ?
      ORDER BY parse_attempts, received_at LIMIT ?`,
  )
    .bind(Date.now() - 2 * 60 * 1000, MAX_PARSE_ATTEMPTS, RETRY_BATCH)
    .all<{ id: number; r2_prefix: string }>();
  for (const row of results) {
    await env.DB.prepare('UPDATE messages SET parse_attempts = parse_attempts + 1 WHERE id = ?').bind(row.id).run();
    try {
      await ingestMessage(env, row.id, row.r2_prefix);
    } catch (err) {
      console.error(`retry parse failed for message ${row.id}`, err);
      await recordParseFailure(env, row.id, err, true);
    }
  }
}

async function purgeFolder(env: Env, folder: 'trash' | 'spam', retentionDays: number) {
  if (!(retentionDays > 0)) return;
  const { results } = await env.DB.prepare(
    `SELECT id, r2_prefix, attachment_count FROM messages
      WHERE folder = ? AND COALESCE(folder_changed_at, received_at) < ? LIMIT 200`,
  )
    .bind(folder, Date.now() - retentionDays * DAY)
    .all<{ id: number; r2_prefix: string; attachment_count: number }>();
  await purgeMessages(env, results);
}

export async function runMaintenance(env: Env) {
  await retryPending(env);
  await purgeFolder(env, 'trash', Number(env.TRASH_RETENTION_DAYS));
  await purgeFolder(env, 'spam', Number(env.SPAM_RETENTION_DAYS));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
    env.DB.prepare('DELETE FROM login_attempts WHERE reset_at < ?').bind(Date.now()),
  ]);
}
