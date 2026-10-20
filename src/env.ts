import type { Realtime } from './realtime';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  REALTIME: DurableObjectNamespace<Realtime>;

  /** HMAC key for signed inline-image URLs. */
  SESSION_SECRET: string;
  /** One-time code required to create the first admin. */
  SETUP_TOKEN?: string;
  /** Optional. Enables domain onboarding from the admin UI. */
  CF_API_TOKEN?: string;

  WORKER_NAME: string;
  /** Public origin of the web UI, used for links in Bark notifications. */
  PUBLIC_URL?: string;
  /** PBKDF2 iterations for new password hashes (10k-100k). Keep low on the Workers Free plan's 10ms CPU budget. */
  PASSWORD_HASH_ITERATIONS: string;
  TRASH_RETENTION_DAYS: string;
  SPAM_RETENTION_DAYS: string;
}

export type Role = 'admin' | 'member';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser; sessionId: string };
};
