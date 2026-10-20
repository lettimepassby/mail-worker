import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Env, Role, SessionUser } from './env';
import { b64ToBytes, bytesToB64, randomToken, safeEqual, sha256Hex } from './util';

const COOKIE = 'mw_session';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
// Workers caps PBKDF2 at 100k. Each hash records its own count, so raising this later only affects new hashes.
const DEFAULT_ITERATIONS = 100_000;

function iterations(env: Env): number {
  const n = Number(env.PASSWORD_HASH_ITERATIONS);
  return Number.isInteger(n) && n >= 10_000 && n <= 100_000 ? n : DEFAULT_ITERATIONS;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(env: Env, password: string): Promise<string> {
  const n = iterations(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, n);
  return `pbkdf2$${n}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iter || !salt || !hash) return false;
  const actual = await pbkdf2(password, b64ToBytes(salt), Number(iter));
  return safeEqual(bytesToB64(actual), hash);
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 8) throw new Error('密码至少 8 位');
  if (password.length > 200) throw new Error('密码过长');
  return password;
}

function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

function writeCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL / 1000,
  });
}

export async function createSession(c: Context<AppEnv>, userId: number) {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(
      await sha256Hex(token),
      userId,
      now,
      now + SESSION_TTL,
    ),
    c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, userId),
  ]);
  writeCookie(c, token);
}

export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
  deleteCookie(c, COOKIE, { path: '/' });
}

export async function loadSession(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT s.expires_at, u.id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND u.disabled = 0`,
  )
    .bind(id)
    .first<{ expires_at: number; id: number; email: string; name: string; role: Role }>();
  const now = Date.now();
  if (!row || row.expires_at < now) return null;

  // Sliding expiry: refresh once the session is past half its lifetime.
  if (row.expires_at - now < SESSION_TTL / 2) {
    await c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(now + SESSION_TTL, id).run();
    writeCookie(c, token);
  }
  c.set('sessionId', id);
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await loadSession(c);
  if (!user) return c.json({ error: '请先登录' }, 401);
  c.set('user', user);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user')?.role !== 'admin') return c.json({ error: '需要管理员权限' }, 403);
  await next();
};

/**
 * Mutating requests must carry a custom header. Browsers can't add it cross-site
 * without a CORS preflight, which this API never grants.
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD' && c.req.header('x-requested-with') !== 'mail-worker') {
    return c.json({ error: 'Missing X-Requested-With header' }, 403);
  }
  await next();
};

const MAX_FAILURES = 10;
const LOCK_WINDOW = 15 * 60 * 1000;

function attemptKey(c: Context): string {
  return `ip:${c.req.header('cf-connecting-ip') ?? 'local'}`;
}

export async function isLockedOut(c: Context<AppEnv>): Promise<boolean> {
  const row = await c.env.DB.prepare('SELECT count, reset_at FROM login_attempts WHERE key = ?')
    .bind(attemptKey(c))
    .first<{ count: number; reset_at: number }>();
  return !!row && row.reset_at > Date.now() && row.count >= MAX_FAILURES;
}

export async function recordFailure(c: Context<AppEnv>) {
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO login_attempts (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN reset_at < ?3 THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at < ?3 THEN ?2 ELSE reset_at END`,
  )
    .bind(attemptKey(c), now + LOCK_WINDOW, now)
    .run();
}

export async function clearFailures(c: Context<AppEnv>) {
  await c.env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(attemptKey(c)).run();
}
