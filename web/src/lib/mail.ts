import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api, buildQuery, post, type MessageDetail, type MessagePage, type MessageSummary, type View } from '../api';
import { useFeedback } from '../components/feedback';
import { fallbackInterval } from './realtime';

export const VIEW_LABELS: Record<View, string> = {
  inbox: '收件箱',
  starred: '星标邮件',
  all: '全部邮件',
  archive: '已归档',
  spam: '垃圾邮件',
  trash: '回收站',
};

export const isView = (v: string | undefined): v is View => !!v && v in VIEW_LABELS;

export interface ListFilter {
  view: View;
  d: string | null;
  a: string | null;
  q: string | null;
}

export function useMessageList({ view, d, a, q }: ListFilter) {
  return useInfiniteQuery({
    queryKey: ['messages', view, d, a, q],
    queryFn: ({ pageParam }) =>
      api<MessagePage>(`/mail/messages${buildQuery({ view, domain: d, address: a, q, cursor: pageParam })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: fallbackInterval,
  });
}

export type BatchAction = 'read' | 'unread' | 'star' | 'unstar' | 'inbox' | 'archive' | 'spam' | 'trash' | 'delete';

const FLAG_PATCH: Partial<Record<BatchAction, Partial<MessageSummary>>> = {
  read: { is_read: true },
  unread: { is_read: false },
  star: { is_starred: true },
  unstar: { is_starred: false },
};

const SUCCESS: Partial<Record<BatchAction, string>> = {
  inbox: '已移到收件箱',
  archive: '已归档',
  spam: '已标记为垃圾邮件',
  trash: '已移到回收站',
  delete: '已彻底删除',
};

/** Runs a batch action with an optimistic cache update, then refetches. */
export function useMessageActions() {
  const qc = useQueryClient();
  const { toast, error } = useFeedback();

  return useCallback(
    async (ids: number[], action: BatchAction, opts: { silent?: boolean } = {}) => {
      if (ids.length === 0) return;
      const set = new Set(ids);
      const flags = FLAG_PATCH[action];
      qc.setQueriesData<InfiniteData<MessagePage>>({ queryKey: ['messages'] }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((p) => ({
                ...p,
                items: flags
                  ? p.items.map((m) => (set.has(m.id) ? { ...m, ...flags } : m))
                  : p.items.filter((m) => !set.has(m.id)),
              })),
            }
          : data,
      );
      if (flags) {
        for (const id of ids) {
          qc.setQueryData<MessageDetail>(['message', id], (d) => (d ? { ...d, message: { ...d.message, ...flags } } : d));
        }
      }
      try {
        await post('/mail/messages/batch', { ids, action });
        if (!opts.silent && SUCCESS[action]) toast(ids.length > 1 ? `${SUCCESS[action]}（${ids.length} 封）` : SUCCESS[action]!);
      } catch (err) {
        error(err);
      } finally {
        qc.invalidateQueries({ queryKey: ['messages'] });
        qc.invalidateQueries({ queryKey: ['mailboxes'] });
        if (!flags) for (const id of ids) qc.invalidateQueries({ queryKey: ['message', id] });
      }
    },
    [qc, toast, error],
  );
}
