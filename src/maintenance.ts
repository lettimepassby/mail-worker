import type { Env } from './env';
import { ingestMessage, MAX_PARSE_ATTEMPTS, recordParseFailure } from './ingest';
import { FREE_LIMITS, getSettings, getUsage } from './settings';
import { PURGE_COLUMNS, purgeMessages, type PurgeRow } from './storage';

const DAY = 24 * 3600 * 1000;

// Small batches: on the Free plan a cron run gets 10ms CPU and 50 D1 queries.
const RETRY_BATCH = 3;
const PURGE_BATCH = 200;
const PURGE_ROUNDS = 2;

/**
 * Re-parses messages still pending a couple of minutes after arrival. Each
 * attempt is counted before parsing starts, so a message that keeps getting
 * the invocation killed (CPU limit) still runs out of attempts and is marked
 * failed instead of blocking the queue forever.
 */
export async function retryPending(env: Env) {
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

/** Deletes rows matching `where` in batches; returns how many were removed. */
async function purgeWhere(env: Env, where: string, params: unknown[]): Promise<number> {
  let total = 0;
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    const { results } = await env.DB.prepare(`SELECT ${PURGE_COLUMNS} FROM messages m WHERE ${where} LIMIT ${PURGE_BATCH}`)
      .bind(...params)
      .all<PurgeRow>();
    await purgeMessages(env, results);
    total += results.length;
    if (results.length < PURGE_BATCH) break;
  }
  return total;
}

/**
 * Hourly: apply retention, and if storage is close to the Free plan limits,
 * empty trash and spam regardless of their retention. Queries range over
 * indexes, so an hour with nothing to delete reads almost no rows.
 */
export async function cleanup(env: Env) {
  const settings = await getSettings(env);
  const now = Date.now();
  const purged: Record<string, number> = {};

  for (const folder of ['trash', 'spam'] as const) {
    const days = folder === 'trash' ? settings.trash_retention_days : settings.spam_retention_days;
    if (days > 0) purged[folder] = await purgeWhere(env, 'm.folder = ? AND m.folder_changed_at < ?', [folder, now - days * DAY]);
  }
  if (settings.mail_retention_days > 0) {
    const cutoff = now - settings.mail_retention_days * DAY;
    for (const folder of ['inbox', 'archive'] as const) {
      purged[folder] = await purgeWhere(env, 'm.folder = ? AND m.received_at < ? AND m.is_starred = 0', [folder, cutoff]);
    }
  }

  const usage = await getUsage(env);
  if (usage.d1Bytes > FREE_LIMITS.d1Bytes * 0.9 || usage.r2Bytes > FREE_LIMITS.r2Bytes * 0.9) {
    console.warn('storage above 90% of the free limit; emptying trash and spam', usage);
    purged.emergency = await purgeWhere(env, "m.folder IN ('trash', 'spam')", []);
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM login_attempts WHERE reset_at < ?').bind(now),
    env.DB.prepare('DELETE FROM usage_daily WHERE day < ?').bind(new Date(now - 90 * DAY).toISOString().slice(0, 10)),
  ]);
  if (Object.values(purged).some(Boolean)) console.log('cleanup', purged);
}
