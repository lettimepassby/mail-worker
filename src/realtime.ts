import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

/** What a connected client may see; mirrors `scopeFor` in access.ts. */
export interface ClientScope {
  admin: boolean;
  domains: string[];
  addresses: string[];
}

export interface MailEvent {
  type: 'mail';
  id: number;
  domain: string;
  address: string;
  folder: string;
  subject: string;
  from: string;
  code: string | null;
}

/**
 * Single hub that fans new-mail events out to every open browser tab over
 * WebSocket. Uses the hibernation API, so idle connections cost nothing and
 * the ping/pong keepalive is answered by the runtime without waking the object.
 */
export class Realtime extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const scope = JSON.parse(request.headers.get('x-client-scope') ?? 'null') as ClientScope | null;
    if (!scope) return new Response('Missing scope', { status: 400 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(scope);
    return new Response(null, { status: 101, webSocket: client });
  }

  async publish(event: MailEvent): Promise<number> {
    const payload = JSON.stringify(event);
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const scope = ws.deserializeAttachment() as ClientScope | null;
      if (!scope) continue;
      if (!scope.admin && !scope.domains.includes(event.domain) && !scope.addresses.includes(event.address)) continue;
      try {
        ws.send(payload);
        sent++;
      } catch {
        // Socket already gone; the runtime cleans it up.
      }
    }
    return sent;
  }

  async webSocketMessage() {
    // Clients only send keepalive pings, which the auto-response handles.
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      // Already closed.
    }
  }
}

export function realtimeHub(env: Env) {
  return env.REALTIME.get(env.REALTIME.idFromName('hub'));
}

export async function publishMail(env: Env, event: MailEvent) {
  try {
    await realtimeHub(env).publish(event);
  } catch (err) {
    console.error('realtime publish failed', err);
  }
}
