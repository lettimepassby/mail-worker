import { Hono, type Context } from 'hono';
import { hashPassword, requireAdmin, requireUser, validatePassword } from '../auth';
import {
  Cloudflare,
  forwardTargets,
  isWorkerAction,
  ruleAddress,
  ruleId,
  type RoutingRule,
} from '../cloudflare';
import type { AppEnv, Role } from '../env';
import { badRequest, domainOf, forbidden, isEmail, normalizeAddress, notFound } from '../util';

interface AccessEntry {
  kind: 'domain' | 'address';
  value: string;
}

function parseAccess(input: unknown): AccessEntry[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: AccessEntry[] = [];
  for (const item of input) {
    const kind = item?.kind;
    const value = typeof item?.value === 'string' ? item.value.trim().toLowerCase() : '';
    if ((kind !== 'domain' && kind !== 'address') || !value) badRequest('权限项格式错误');
    if (kind === 'address' && !isEmail(value)) badRequest(`无效地址：${value}`);
    const key = `${kind}:${value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind, value });
    }
  }
  return out;
}

function parseRole(input: unknown): Role {
  if (input !== 'admin' && input !== 'member') badRequest('角色无效');
  return input;
}

function passwordOrThrow(input: unknown): string {
  try {
    return validatePassword(input);
  } catch (e) {
    badRequest((e as Error).message);
  }
}

async function otherActiveAdmins(db: D1Database, excludeId: number): Promise<number> {
  return (
    (await db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?")
      .bind(excludeId)
      .first<number>('n')) ?? 0
  );
}

function cloudflare(c: Context<AppEnv>): Cloudflare {
  if (!c.env.CF_API_TOKEN) badRequest('未配置 CF_API_TOKEN，无法调用 Cloudflare API');
  return new Cloudflare(c.env.CF_API_TOKEN);
}

const admin = new Hono<AppEnv>();
admin.use('*', requireUser, requireAdmin);

// Users ----------------------------------------------------------------------

admin.get('/users', async (c) => {
  const [users, access] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare('SELECT id, email, name, role, disabled, created_at, last_login_at FROM users ORDER BY id'),
    c.env.DB.prepare('SELECT user_id, kind, value FROM user_access ORDER BY kind, value'),
  ]);
  return c.json({
    users: users.results.map((u) => ({
      ...u,
      disabled: !!u.disabled,
      access: access.results.filter((a) => a.user_id === u.id).map((a) => ({ kind: a.kind, value: a.value })),
    })),
  });
});

admin.post('/users', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const email = normalizeAddress(String(body.email ?? ''));
  if (!isEmail(email)) badRequest('请输入有效的邮箱作为登录名');
  const role = parseRole(body.role ?? 'member');
  const password = passwordOrThrow(body.password);
  const access = parseAccess(body.access);

  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (exists) badRequest('该登录名已存在');
  const user = await c.env.DB.prepare(
    'INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
  )
    .bind(email, String(body.name ?? '').trim(), await hashPassword(c.env, password), role, Date.now())
    .first<{ id: number }>();
  if (!user) throw new Error('创建用户失败');
  if (access.length > 0) {
    await c.env.DB.batch(
      access.map((a) =>
        c.env.DB.prepare('INSERT INTO user_access (user_id, kind, value) VALUES (?, ?, ?)').bind(user.id, a.kind, a.value),
      ),
    );
  }
  return c.json({ ok: true, id: user.id });
});

admin.patch('/users/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const me = c.get('user');
  const body = await c.req.json<Record<string, unknown>>();
  const current = await c.env.DB.prepare('SELECT role, disabled FROM users WHERE id = ?')
    .bind(id)
    .first<{ role: Role; disabled: number }>();
  if (!current) notFound('用户不存在');

  const stmts: D1PreparedStatement[] = [];
  const db = c.env.DB;
  if (typeof body.name === 'string') stmts.push(db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(body.name.trim(), id));

  const demoting = body.role !== undefined && parseRole(body.role) === 'member' && current.role === 'admin';
  const disabling = body.disabled === true && !current.disabled;
  if ((demoting || disabling) && id === me.id) forbidden('不能降级或停用自己');
  if ((demoting || disabling) && current.role === 'admin' && (await otherActiveAdmins(db, id)) === 0) {
    forbidden('至少需要保留一个可用的管理员');
  }
  if (body.role !== undefined) stmts.push(db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(parseRole(body.role), id));
  if (typeof body.disabled === 'boolean') {
    stmts.push(db.prepare('UPDATE users SET disabled = ? WHERE id = ?').bind(body.disabled ? 1 : 0, id));
    if (body.disabled) stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  }
  if (body.password !== undefined && body.password !== '') {
    stmts.push(
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(c.env, passwordOrThrow(body.password)), id),
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    );
  }
  if (body.access !== undefined) {
    const access = parseAccess(body.access);
    stmts.push(db.prepare('DELETE FROM user_access WHERE user_id = ?').bind(id));
    for (const a of access) {
      stmts.push(db.prepare('INSERT INTO user_access (user_id, kind, value) VALUES (?, ?, ?)').bind(id, a.kind, a.value));
    }
  }
  if (stmts.length > 0) await db.batch(stmts);
  return c.json({ ok: true });
});

admin.delete('/users/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (id === c.get('user').id) forbidden('不能删除自己');
  const current = await c.env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(id).first<{ role: Role }>();
  if (!current) notFound('用户不存在');
  if (current.role === 'admin' && (await otherActiveAdmins(c.env.DB, id)) === 0) forbidden('至少需要保留一个可用的管理员');
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// Domains & addresses ----------------------------------------------------------

admin.get('/domains', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.name, d.policy, d.zone_id, d.created_at,
            (SELECT COUNT(*) FROM addresses a WHERE a.domain = d.name) AS address_count,
            (SELECT COUNT(*) FROM messages m WHERE m.domain = d.name) AS message_count,
            (SELECT MAX(a.last_received_at) FROM addresses a WHERE a.domain = d.name) AS last_received_at
       FROM domains d ORDER BY d.name`,
  ).all();
  return c.json({ domains: results, cloudflareConfigured: !!c.env.CF_API_TOKEN, workerName: c.env.WORKER_NAME });
});

admin.patch('/domains/:name', async (c) => {
  const name = c.req.param('name').toLowerCase();
  const { policy } = await c.req.json<{ policy?: string }>();
  if (policy !== 'accept_all' && policy !== 'known_only') badRequest('策略无效');
  const res = await c.env.DB.prepare('UPDATE domains SET policy = ? WHERE name = ?').bind(policy, name).run();
  if (!res.meta.changes) notFound('域名不存在');
  return c.json({ ok: true });
});

admin.get('/addresses', async (c) => {
  const domain = c.req.query('domain')?.toLowerCase();
  const { results } = await c.env.DB.prepare(
    `SELECT a.address, a.domain, a.status, a.note, a.created_at, a.last_received_at,
            (SELECT COUNT(*) FROM messages m WHERE m.address = a.address) AS message_count
       FROM addresses a ${domain ? 'WHERE a.domain = ?' : ''}
      ORDER BY a.domain, a.address`,
  )
    .bind(...(domain ? [domain] : []))
    .all();
  return c.json({ addresses: results });
});

admin.post('/addresses', async (c) => {
  const body = await c.req.json<{ address?: string; note?: string }>();
  const address = normalizeAddress(body.address ?? '');
  if (!isEmail(address)) badRequest('地址无效');
  const domain = domainOf(address);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO domains (name, created_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING').bind(domain, now),
    c.env.DB.prepare(
      `INSERT INTO addresses (address, domain, note, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET note = excluded.note, status = 'active'`,
    ).bind(address, domain, (body.note ?? '').trim(), now),
  ]);
  return c.json({ ok: true });
});

admin.patch('/addresses/:address', async (c) => {
  const address = normalizeAddress(c.req.param('address'));
  const body = await c.req.json<{ status?: string; note?: string }>();
  const stmts: D1PreparedStatement[] = [];
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'blocked') badRequest('状态无效');
    stmts.push(c.env.DB.prepare('UPDATE addresses SET status = ? WHERE address = ?').bind(body.status, address));
  }
  if (typeof body.note === 'string') {
    stmts.push(c.env.DB.prepare('UPDATE addresses SET note = ? WHERE address = ?').bind(body.note.trim(), address));
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

admin.delete('/addresses/:address', async (c) => {
  await c.env.DB.prepare('DELETE FROM addresses WHERE address = ?').bind(normalizeAddress(c.req.param('address'))).run();
  return c.json({ ok: true });
});

// Forwards & blocklist ---------------------------------------------------------

admin.get('/forwards', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, source, destination, created_at FROM forwards ORDER BY source').all();
  return c.json({ forwards: results });
});

admin.post('/forwards', async (c) => {
  const body = await c.req.json<{ source?: string; destination?: string }>();
  const source = normalizeAddress(body.source ?? '');
  const destination = normalizeAddress(body.destination ?? '');
  if (!isEmail(source.replace(/^\*@/, 'x@'))) badRequest('来源需为完整地址或 *@域名');
  if (!isEmail(destination)) badRequest('目标地址无效');
  await c.env.DB.prepare('INSERT INTO forwards (source, destination, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
    .bind(source, destination, Date.now())
    .run();
  return c.json({ ok: true });
});

admin.delete('/forwards/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM forwards WHERE id = ?').bind(Number(c.req.param('id'))).run();
  return c.json({ ok: true });
});

admin.get('/blocklist', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT pattern, note, created_at FROM blocked_senders ORDER BY pattern').all();
  return c.json({ blocked: results });
});

admin.post('/blocklist', async (c) => {
  const body = await c.req.json<{ pattern?: string; note?: string }>();
  const pattern = normalizeAddress(body.pattern ?? '');
  if (!isEmail(pattern) && !isEmail(`x${pattern}`)) badRequest('请填写发件地址，或 @域名 屏蔽整个域名');
  await c.env.DB.prepare(
    'INSERT INTO blocked_senders (pattern, note, created_at) VALUES (?, ?, ?) ON CONFLICT (pattern) DO UPDATE SET note = excluded.note',
  )
    .bind(pattern, (body.note ?? '').trim(), Date.now())
    .run();
  return c.json({ ok: true });
});

admin.delete('/blocklist/:pattern', async (c) => {
  await c.env.DB.prepare('DELETE FROM blocked_senders WHERE pattern = ?').bind(normalizeAddress(c.req.param('pattern'))).run();
  return c.json({ ok: true });
});

// Cloudflare onboarding ----------------------------------------------------------

admin.get('/cloudflare/zones', async (c) => {
  if (!c.env.CF_API_TOKEN) return c.json({ configured: false, zones: [] });
  const zones = await cloudflare(c).listZones();
  return c.json({
    configured: true,
    zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status })).sort((a, b) => a.name.localeCompare(b.name)),
  });
});

function presentRule(rule: RoutingRule, worker: string) {
  return {
    id: ruleId(rule),
    name: rule.name,
    enabled: rule.enabled,
    address: ruleAddress(rule),
    actions: rule.actions,
    managed: isWorkerAction(rule, worker),
    forwards: forwardTargets(rule),
  };
}

admin.get('/cloudflare/zones/:id', async (c) => {
  const cf = cloudflare(c);
  const id = c.req.param('id');
  const worker = c.env.WORKER_NAME;
  const [routing, catchAll, rules] = await Promise.all([
    cf.getRouting(id).catch(() => null),
    cf.getCatchAll(id).catch(() => null),
    cf.listRules(id).catch(() => [] as RoutingRule[]),
  ]);
  return c.json({
    routing,
    catchAll: catchAll ? presentRule(catchAll, worker) : null,
    managed: !!catchAll?.enabled && isWorkerAction(catchAll, worker),
    rules: rules.filter((r) => r.matchers.every((m) => m.type !== 'all')).map((r) => presentRule(r, worker)),
  });
});

/**
 * Enables Email Routing on the zone and points its catch-all at this Worker.
 * With keepForward, the Worker keeps forwarding to the old catch-all destinations.
 */
admin.post('/cloudflare/zones/:id/enable', async (c) => {
  const cf = cloudflare(c);
  const id = c.req.param('id');
  const { keepForward = false } = await c.req.json<{ keepForward?: boolean }>().catch(() => ({ keepForward: false }));
  const zone = await cf.getZone(id);
  const routing = await cf.getRouting(id).catch(() => null);
  if (!routing?.enabled) await cf.enableRouting(id);

  const previous = await cf.getCatchAll(id).catch(() => null);
  const keep = keepForward && previous?.enabled ? forwardTargets(previous) : [];
  const now = Date.now();
  const db = c.env.DB;
  await db.batch([
    db
      .prepare(
        'INSERT INTO domains (name, zone_id, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET zone_id = excluded.zone_id',
      )
      .bind(zone.name, zone.id, now),
    ...keep.map((dest) =>
      db
        .prepare('INSERT INTO forwards (source, destination, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
        .bind(`*@${zone.name}`, dest.toLowerCase(), now),
    ),
  ]);
  await cf.setCatchAllToWorker(id, c.env.WORKER_NAME);
  return c.json({ ok: true, keptForwards: keep });
});

/**
 * Re-points per-address rules at this Worker so their mail shows up here too,
 * keeping their original forward destinations as Worker-side forwards.
 */
admin.post('/cloudflare/zones/:id/takeover', async (c) => {
  const cf = cloudflare(c);
  const id = c.req.param('id');
  const { ruleIds } = await c.req.json<{ ruleIds?: string[] }>();
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) badRequest('请选择要接管的规则');

  const worker = c.env.WORKER_NAME;
  const rules = (await cf.listRules(id)).filter((r) => ruleIds.includes(ruleId(r)));
  const db = c.env.DB;
  const now = Date.now();
  const done: string[] = [];
  for (const rule of rules) {
    const address = ruleAddress(rule);
    // Only plain forward rules; drop rules and other Workers are left alone.
    if (!address || isWorkerAction(rule, worker) || !rule.actions.every((a) => a.type === 'forward')) continue;
    const domain = domainOf(address);
    await db.batch([
      db.prepare('INSERT INTO domains (name, created_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING').bind(domain, now),
      db
        .prepare('INSERT INTO addresses (address, domain, created_at) VALUES (?, ?, ?) ON CONFLICT (address) DO NOTHING')
        .bind(address, domain, now),
      ...forwardTargets(rule).map((dest) =>
        db
          .prepare('INSERT INTO forwards (source, destination, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
          .bind(address, dest.toLowerCase(), now),
      ),
    ]);
    await cf.updateRule(id, { ...rule, actions: [{ type: 'worker', value: [worker] }] });
    done.push(address);
  }
  return c.json({ ok: true, addresses: done });
});

export default admin;
