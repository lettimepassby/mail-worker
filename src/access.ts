import type { SessionUser } from './env';

export interface Scope {
  sql: string;
  params: unknown[];
}

/**
 * SQL predicate limiting rows to what `user` may read. `alias` must expose
 * `domain` and `address` columns (messages, addresses).
 */
export function scopeFor(user: SessionUser, alias: string): Scope {
  if (user.role === 'admin') return { sql: '1 = 1', params: [] };
  return {
    sql: `(${alias}.domain IN (SELECT value FROM user_access WHERE user_id = ? AND kind = 'domain')
        OR ${alias}.address IN (SELECT value FROM user_access WHERE user_id = ? AND kind = 'address'))`,
    params: [user.id, user.id],
  };
}
