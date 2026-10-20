import { Hono } from 'hono';
import {
  clearFailures,
  createSession,
  destroySession,
  hashPassword,
  isLockedOut,
  loadSession,
  recordFailure,
  requireUser,
  validatePassword,
  verifyPassword,
} from '../auth';
import type { AppEnv } from '../env';
import { badRequest, isEmail, normalizeAddress, safeEqual } from '../util';

const auth = new Hono<AppEnv>();

async function userCount(db: D1Database): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM users').first<number>('n')) ?? 0;
}

auth.get('/state', async (c) => {
  const needsSetup = (await userCount(c.env.DB)) === 0;
  const user = needsSetup ? null : await loadSession(c);
  return c.json({ needsSetup, user });
});

auth.post('/setup', async (c) => {
  const body = await c.req.json<{ token?: string; email?: string; name?: string; password?: string }>();
  if ((await userCount(c.env.DB)) > 0) badRequest('系统已初始化');
  if (!c.env.SETUP_TOKEN || !safeEqual(body.token ?? '', c.env.SETUP_TOKEN)) {
    await recordFailure(c);
    badRequest('初始化码不正确');
  }
  const email = normalizeAddress(body.email ?? '');
  if (!isEmail(email)) badRequest('请输入有效的邮箱作为登录名');
  let password: string;
  try {
    password = validatePassword(body.password);
  } catch (e) {
    badRequest((e as Error).message);
  }
  const user = await c.env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role, created_at)
     SELECT ?, ?, ?, 'admin', ? WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING id`,
  )
    .bind(email, (body.name ?? '').trim(), await hashPassword(c.env, password), Date.now())
    .first<{ id: number }>();
  if (!user) badRequest('系统已初始化');
  await createSession(c, user.id);
  return c.json({ ok: true });
});

auth.post('/login', async (c) => {
  if (await isLockedOut(c)) return c.json({ error: '失败次数过多，请 15 分钟后再试' }, 429);
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = normalizeAddress(body.email ?? '');
  const row = await c.env.DB.prepare('SELECT id, password_hash, disabled FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; password_hash: string; disabled: number }>();
  const ok = row && !row.disabled && (await verifyPassword(body.password ?? '', row.password_hash));
  if (!ok) {
    await recordFailure(c);
    return c.json({ error: '账号或密码错误' }, 401);
  }
  await clearFailures(c);
  await createSession(c, row.id);
  return c.json({ ok: true });
});

auth.post('/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

auth.post('/password', requireUser, async (c) => {
  const body = await c.req.json<{ current?: string; next?: string }>();
  const user = c.get('user');
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(body.current ?? '', row.password_hash))) badRequest('当前密码不正确');
  let next: string;
  try {
    next = validatePassword(body.next);
  } catch (e) {
    badRequest((e as Error).message);
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(c.env, next), user.id),
    // Sign out every other session.
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, c.get('sessionId')),
  ]);
  return c.json({ ok: true });
});

export default auth;
