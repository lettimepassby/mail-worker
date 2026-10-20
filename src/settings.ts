import type { Env } from './env';

export interface Settings {
  /** Days a message stays in trash / spam before permanent deletion (0 = keep). */
  trash_retention_days: number;
  spam_retention_days: number;
  /** Days before inbox/archive mail is deleted, starred mail excepted (0 = keep forever). */
  mail_retention_days: number;
}

export const SETTING_KEYS: (keyof Settings)[] = ['trash_retention_days', 'spam_retention_days', 'mail_retention_days'];

export async function getSettings(env: Env): Promise<Settings> {
  const defaults: Settings = {
    trash_retention_days: Number(env.TRASH_RETENTION_DAYS) || 0,
    spam_retention_days: Number(env.SPAM_RETENTION_DAYS) || 0,
    mail_retention_days: 0,
  };
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  for (const r of results) {
    if ((SETTING_KEYS as string[]).includes(r.key)) defaults[r.key as keyof Settings] = Number(r.value) || 0;
  }
  return defaults;
}

// Workers Free plan limits that matter for this app.
export const FREE_LIMITS = {
  d1Bytes: 500 * 1024 * 1024,
  r2Bytes: 10 * 1024 * 1024 * 1024,
  workerRequestsPerDay: 100_000,
  d1RowsWrittenPerDay: 100_000,
  d1RowsReadPerDay: 5_000_000,
};

export interface Usage {
  d1Bytes: number;
  r2Bytes: number;
  messages: number;
}

export async function getUsage(env: Env): Promise<Usage> {
  const res = await env.DB.prepare("SELECT key, value FROM counters WHERE key IN ('messages', 'r2_bytes')").all<{
    key: string;
    value: number;
  }>();
  const counters = Object.fromEntries(res.results.map((r) => [r.key, r.value]));
  return { d1Bytes: res.meta.size_after, r2Bytes: counters.r2_bytes ?? 0, messages: counters.messages ?? 0 };
}

export const today = () => new Date().toISOString().slice(0, 10);
