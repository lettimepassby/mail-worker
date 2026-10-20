# mail-worker

基于 Cloudflare 的多域名统一收件系统。所有域名的邮件通过 Email Routing 的 catch-all 交给同一个 Worker，存进 R2 和 D1，在 `mail.你的域名` 上用网页统一查看。

只收不发，供内部人员使用，用网页查看。

## 功能

- 所有域名的邮件集中在一个收件箱，可按域名或地址筛选，每个域名有自己的颜色标记
- 全文搜索：主题、发件人、收件人、正文都能搜，中文同样适用（基于 FTS5 trigram）
- 归档、星标、垃圾邮件、回收站；回收站和垃圾邮件 30 天后自动清理
- HTML 邮件在沙箱 iframe 中渲染，默认拦截远程图片（追踪像素）；内嵌图片和附件可以正常查看和下载
- 显示 SPF / DKIM / DMARC 结果；DMARC 校验失败的邮件自动进入垃圾邮件并显示警告
- 多用户：管理员看全部，成员只看分配给他们的域名或地址
- 收信策略：每个域名可选择接收所有地址，或只接收列表中的地址；可屏蔽单个地址、拦截发件人，这些都在 SMTP 阶段直接拒收
- 转发：邮件存档后，再由 Worker 转发一份到已验证的邮箱
- 一键接入：配置 API Token 后，可在后台对账号下的域名启用 Email Routing 并把 catch-all 指向本 Worker；原有的转发规则可以接管，转发不会中断

## 架构

```
各域名 MX (Email Routing catch-all) ──► Worker email()
                                          │ 策略检查 → 原文存 R2 → 写 D1 → 解析 → 转发
                                          ▼
          R2: mail/{日期}/{uuid}/raw.eml, body.json, att/{n}
          D1: messages / attachments / messages_fts / users / ...
                                          ▲
浏览器 ──► mail.example.com ──► Worker fetch()：/api/* 由 Hono 处理，其余是静态 SPA
Cron 每 10 分钟：重试解析失败的邮件、清理回收站、清理过期会话
```

## 首次部署

前提：Cloudflare 账号，并且 R2 已开通（在控制台的 R2 页面开通一次，免费额度足够）。推荐使用 Workers 付费版（$5/月）：解析大邮件和登录时的密码哈希都可能超过免费版 10ms 的 CPU 限制。

```bash
npm install
npx wrangler login

# 1. 创建 D1 和 R2，把 D1 的 database_id 填进 wrangler.jsonc
npx wrangler d1 create mail-worker
npx wrangler r2 bucket create mail-worker

# 2. 在 wrangler.jsonc 中启用自定义域名（把 routes 那一行取消注释并改成你的域名）
#    "routes": [{ "pattern": "mail.example.com", "custom_domain": true }]

# 3. 设置密钥
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
openssl rand -hex 8     | tee /dev/stderr | npx wrangler secret put SETUP_TOKEN   # 记下输出的初始化码

# 4. 建表、构建、部署
npm run deploy
```

打开 `https://mail.example.com`，用初始化码创建第一个管理员。之后初始化入口会自动关闭。

## 接入域名

**方式一：在后台一键接入（推荐）**

1. 在 Cloudflare 控制台 → 我的个人资料 → API 令牌，创建自定义令牌：
   - 区域 · 读取
   - 区域 · Email Routing 规则 · 编辑
   - 区域 · DNS · 编辑
   - 区域 · 区域设置 · 编辑
   - 区域资源：所有区域
2. 运行 `npx wrangler secret put CF_API_TOKEN` 并粘贴令牌
3. 在后台打开「域名与接入」，对每个域名点「接入」。如果有单独的转发规则，再点「接管规则」

**方式二：手动接入**

对每个域名，在 Cloudflare 控制台 → 电子邮件 → 电子邮件路由 → 路由规则中，把 Catch-all 设为「发送到 Worker」并选择 `mail-worker`。

> 单独地址的路由规则优先于 catch-all。它们如果还是"转发到某邮箱"，邮件就不会进入本系统，需要接管，或改成发送到 Worker。

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                 # 构建前端并在 http://localhost:8799 启动 wrangler dev

# 模拟收信
curl -X POST 'http://localhost:8799/cdn-cgi/handler/email?from=a@x.com&to=hello@example.com' \
  --data-binary @some.eml
```

改前端时可以另开一个终端运行 `npm run dev:web`，使用 Vite 热更新，`/api` 会代理到 8799。

## 配置

| 名称 | 类型 | 说明 |
|---|---|---|
| `SESSION_SECRET` | secret | 内嵌图片签名链接的 HMAC 密钥 |
| `SETUP_TOKEN` | secret | 创建首个管理员用的一次性初始化码 |
| `CF_API_TOKEN` | secret，可选 | 后台一键接入域名时使用 |
| `WORKER_NAME` | var | catch-all 指向的 Worker 名，需与 `name` 一致 |
| `TRASH_RETENTION_DAYS` / `SPAM_RETENTION_DAYS` | var | 回收站 / 垃圾邮件保留天数，设为 0 表示不自动清理 |

## 限制

- 只能用网页查看，不支持 IMAP/POP/SMTP 客户端
- 单封邮件最大 25 MiB（Email Routing 的限制）
- 转发目标必须先在 Cloudflare 的「目标地址」中验证
- 少于 3 个字的搜索词只匹配主题、发件人和摘要
