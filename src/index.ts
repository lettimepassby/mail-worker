import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { csrfGuard } from './auth';
import { CloudflareError } from './cloudflare';
import type { AppEnv, Env } from './env';
import { handleEmail } from './inbound';
import { runMaintenance } from './maintenance';
import admin from './routes/admin';
import auth from './routes/auth';
import mail, { inline } from './routes/mail';

const app = new Hono<AppEnv>().basePath('/api');

app.use('*', async (c, next) => {
  await next();
  c.header('cache-control', c.res.headers.get('cache-control') ?? 'no-store');
  c.header('x-content-type-options', 'nosniff');
});
app.use('*', csrfGuard);

app.route('/auth', auth);
app.route('/mail', mail);
app.route('/admin', admin);
app.route('/inline', inline);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof CloudflareError) return c.json({ error: `Cloudflare API：${err.message}` }, 502);
  if (err instanceof SyntaxError) return c.json({ error: '请求体不是有效的 JSON' }, 400);
  console.error(err);
  return c.json({ error: '服务器内部错误' }, 500);
});

export default {
  fetch: app.fetch,

  async email(message, env, ctx) {
    await handleEmail(message, env, ctx);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runMaintenance(env));
  },
} satisfies ExportedHandler<Env>;
