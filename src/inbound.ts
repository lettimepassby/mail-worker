import { decodeWords } from 'postal-mime';
import type { Env } from './env';
import { ingestMessage, recordParseFailure } from './ingest';
import { today } from './settings';
import { newPrefix, rawKey } from './storage';
import { collapseWhitespace, domainOf, normalizeAddress } from './util';

interface RoutingDecision {
  reject?: string;
  forwards: string[];
}

async function decide(env: Env, to: string, from: string): Promise<RoutingDecision> {
  const domain = domainOf(to);
  const fromDomain = from.includes('@') ? `@${domainOf(from)}` : '';
  const [policy, address, blocked, forwards] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare('SELECT policy FROM domains WHERE name = ?').bind(domain),
    env.DB.prepare('SELECT status FROM addresses WHERE address = ?').bind(to),
    env.DB.prepare('SELECT 1 FROM blocked_senders WHERE pattern IN (?, ?) LIMIT 1').bind(from, fromDomain),
    env.DB.prepare('SELECT DISTINCT destination FROM forwards WHERE source IN (?, ?)').bind(to, `*@${domain}`),
  ]);

  const addressStatus = address.results[0]?.status;
  if (addressStatus === 'blocked') return { reject: '550 5.1.1 Mailbox unavailable', forwards: [] };
  if (policy.results[0]?.policy === 'known_only' && !addressStatus) {
    return { reject: '550 5.1.1 User unknown', forwards: [] };
  }
  if (blocked.results.length > 0) return { reject: '550 5.7.1 Message rejected', forwards: [] };
  return { forwards: forwards.results.map((r) => String(r.destination)) };
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
  const to = normalizeAddress(message.to);
  const from = normalizeAddress(message.from);
  const domain = domainOf(to);

  const decision = await decide(env, to, from);
  if (decision.reject) {
    message.setReject(decision.reject);
    return;
  }

  // Store the raw message before anything else so nothing is lost if parsing fails.
  const raw = await new Response(message.raw).arrayBuffer();
  const prefix = newPrefix();
  await env.BUCKET.put(rawKey(prefix), raw, { httpMetadata: { contentType: 'message/rfc822' } });

  const now = Date.now();
  const subject = collapseWhitespace(decodeWords(message.headers.get('subject') ?? ''));
  const [, , inserted] = await env.DB.batch([
    env.DB.prepare('INSERT INTO domains (name, created_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING').bind(
      domain,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO addresses (address, domain, created_at, last_received_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (address) DO UPDATE SET last_received_at = excluded.last_received_at`,
    ).bind(to, domain, now),
    env.DB.prepare(
      `INSERT INTO messages (r2_prefix, domain, address, envelope_from, from_addr, subject, received_at, size, r2_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(prefix, domain, to, from, from, subject, now, raw.byteLength, raw.byteLength),
    env.DB.prepare(
      "UPDATE counters SET value = value + CASE key WHEN 'messages' THEN 1 ELSE ? END WHERE key IN ('messages', 'r2_bytes')",
    ).bind(raw.byteLength),
    env.DB.prepare(
      `INSERT INTO usage_daily (day, messages, bytes) VALUES (?, 1, ?)
       ON CONFLICT (day) DO UPDATE SET messages = messages + 1, bytes = bytes + excluded.bytes`,
    ).bind(today(), raw.byteLength),
  ]);
  const id = (inserted.results[0] as { id: number }).id;

  for (const destination of decision.forwards) {
    try {
      await message.forward(destination);
    } catch (err) {
      console.error(`forward to ${destination} failed`, err);
    }
  }

  // Parse after accepting the message: SMTP delivery must not depend on parsing,
  // which can exceed the CPU budget on large mail. Anything left pending is
  // picked up by the scheduled job.
  ctx.waitUntil(
    ingestMessage(env, id, prefix, raw).catch(async (err) => {
      console.error(`parse failed for message ${id}`, err);
      await recordParseFailure(env, id, err);
    }),
  );
}
