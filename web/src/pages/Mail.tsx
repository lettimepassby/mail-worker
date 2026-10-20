import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import type { MessagePage } from '../api';
import MessageList from '../components/MessageList';
import MessageView from '../components/MessageView';
import { cx, Empty } from '../components/ui';
import { isView, type ListFilter } from '../lib/mail';

export default function MailPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  if (!isView(params.view)) return <Navigate to="/mail/inbox" replace />;
  const filter: ListFilter = { view: params.view, d: search.get('d'), a: search.get('a'), q: search.get('q') };
  const selectedId = params.id ? Number(params.id) : null;
  const qs = search.toString() ? `?${search}` : '';
  const listHref = `/mail/${filter.view}${qs}`;

  /** After archiving/deleting the open message, move on to its neighbour like a mail client would. */
  const openNeighbour = () => {
    const data = qc.getQueryData<InfiniteData<MessagePage>>(['messages', filter.view, filter.d, filter.a, filter.q]);
    const items = data?.pages.flatMap((p) => p.items) ?? [];
    const idx = items.findIndex((m) => m.id === selectedId);
    const next = idx >= 0 ? (items[idx + 1] ?? items[idx - 1]) : undefined;
    const wide = window.matchMedia('(min-width: 768px)').matches;
    navigate(next && wide ? `/mail/${filter.view}/${next.id}${qs}` : listHref, { replace: true });
  };

  return (
    <div className="flex h-full">
      <section
        className={cx(
          'min-w-0 flex-col border-r border-zinc-200 md:flex md:w-[340px] md:shrink-0 xl:w-[400px] dark:border-zinc-800',
          selectedId ? 'hidden' : 'flex w-full',
        )}
      >
        <MessageList filter={filter} selectedId={selectedId} />
      </section>
      <section className={cx('min-w-0 flex-1', selectedId ? 'flex' : 'hidden md:flex')}>
        {selectedId ? (
          <MessageView key={selectedId} id={selectedId} onBack={() => navigate(listHref)} onAfterMove={openNeighbour} />
        ) : (
          <div className="flex w-full items-center justify-center bg-zinc-50 dark:bg-zinc-950">
            <Empty icon={<Mail className="size-12" strokeWidth={1} />} title="选择一封邮件阅读" />
          </div>
        )}
      </section>
    </div>
  );
}
