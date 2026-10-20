import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { MailEvent } from '../api';

export type RealtimeStatus = 'connecting' | 'open' | 'closed';

let status: RealtimeStatus = 'closed';
const listeners = new Set<() => void>();

function setStatus(next: RealtimeStatus) {
  status = next;
  listeners.forEach((l) => l());
}

export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => status,
  );
}

/** Polling interval for queries: none while the live connection is up, slow fallback otherwise. */
export const fallbackInterval = () => (status === 'open' ? false : 60_000);

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Keeps one WebSocket to /api/mail/realtime open for the session, reconnecting
 * with backoff. `onOpen` fires on every (re)connect so callers can catch up on
 * anything missed while offline.
 */
export function useRealtime(handlers: { onMail: (e: MailEvent) => void; onOpen: () => void }) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      clearTimeout(retryTimer);
      setStatus('connecting');
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/mail/realtime`);
      ws = socket;
      socket.onopen = () => {
        attempt = 0;
        setStatus('open');
        ref.current.onOpen();
        pingTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('ping'), PING_MS);
      };
      socket.onmessage = (e) => {
        if (e.data === 'pong') return;
        try {
          const event = JSON.parse(e.data);
          if (event?.type === 'mail') ref.current.onMail(event as MailEvent);
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        clearInterval(pingTimer);
        if (ws !== socket) return;
        ws = null;
        setStatus('closed');
        if (!stopped) retryTimer = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt++));
      };
    };

    // Come back quickly after sleep / network changes instead of waiting out the backoff.
    const wake = () => {
      if (!stopped && !ws && document.visibilityState === 'visible') connect();
    };

    connect();
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      const socket = ws;
      ws = null;
      socket?.close();
      setStatus('closed');
    };
  }, []);
}
