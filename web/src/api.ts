export type Role = 'admin' | 'member';
export type Folder = 'inbox' | 'archive' | 'spam' | 'trash';
export type View = Folder | 'starred' | 'all';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export interface AuthState {
  needsSetup: boolean;
  user: User | null;
}

export interface MailboxAddress {
  address: string;
  status: 'active' | 'blocked';
  unread: number;
  lastReceivedAt: number | null;
}

export interface MailboxDomain {
  name: string;
  policy: 'accept_all' | 'known_only';
  unread: number;
  addresses: MailboxAddress[];
}

export interface Mailboxes {
  folders: { inbox: number; spam: number };
  domains: MailboxDomain[];
}

export interface MessageSummary {
  id: number;
  domain: string;
  address: string;
  from_addr: string;
  from_name: string;
  subject: string;
  snippet: string;
  received_at: number;
  sent_at: number | null;
  attachment_count: number;
  folder: Folder;
  is_read: boolean;
  is_starred: boolean;
  status: 'pending' | 'ready' | 'failed';
}

export interface MessagePage {
  items: MessageSummary[];
  nextCursor: string | null;
}

export interface Mailbox {
  name: string;
  address: string;
}

export interface MessageDetail {
  message: MessageSummary & {
    envelope_from: string;
    to: Mailbox[];
    cc: Mailbox[];
    reply_to: string;
    message_id_hdr: string | null;
    size: number;
    spf: string | null;
    dkim: string | null;
    dmarc: string | null;
    parse_error: string | null;
  };
  attachments: {
    idx: number;
    filename: string;
    mime: string;
    size: number;
    content_id: string | null;
    inline: boolean;
    previewable: boolean;
  }[];
  html: string | null;
  text: string | null;
}

export interface AccessEntry {
  kind: 'domain' | 'address';
  value: string;
}

export interface AdminUser extends User {
  disabled: boolean;
  created_at: number;
  last_login_at: number | null;
  access: AccessEntry[];
}

export interface AdminDomain {
  name: string;
  policy: 'accept_all' | 'known_only';
  zone_id: string | null;
  created_at: number;
  address_count: number;
  message_count: number;
  last_received_at: number | null;
}

export interface AdminAddress {
  address: string;
  domain: string;
  status: 'active' | 'blocked';
  note: string;
  created_at: number;
  last_received_at: number | null;
  message_count: number;
}

export interface Forward {
  id: number;
  source: string;
  destination: string;
  created_at: number;
}

export interface BlockedSender {
  pattern: string;
  note: string;
  created_at: number;
}

export interface Zone {
  id: string;
  name: string;
  status: string;
}

export interface ZoneRule {
  id: string;
  name: string;
  enabled: boolean;
  address: string | null;
  actions: { type: 'forward' | 'worker' | 'drop'; value?: string[] }[];
  managed: boolean;
  forwards: string[];
}

export interface ZoneDetail {
  routing: { enabled: boolean; status: string } | null;
  catchAll: ZoneRule | null;
  managed: boolean;
  rules: ZoneRule[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'x-requested-with': 'mail-worker',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    throw new ApiError((data as { error?: string }).error ?? `请求失败（${res.status}）`, res.status);
  }
  return data as T;
}

export const post = <T = { ok: true }>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const patch = <T = { ok: true }>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T = { ok: true }>(path: string) => api<T>(path, { method: 'DELETE' });

export function buildQuery(params: Record<string, string | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
}
