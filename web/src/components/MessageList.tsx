import { useQueryClient } from '@tanstack/react-query';
import { Inbox, Menu, Paperclip, RefreshCw, Search, Star, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { post, type MessageSummary } from '../api';
import { domainHue, senderLabel, shortTime } from '../lib/format';
import { useMessageActions, useMessageList, VIEW_LABELS, type BatchAction, type ListFilter } from '../lib/mail';
import { useNav } from '../lib/session';
import { useFeedback } from './feedback';
import { Button, Checkbox, cx, Empty, IconButton, Spinner } from './ui';

function AddressChip({ address }: { address: string }) {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded bg-zinc-100 px-1.5 py-px text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: `hsl(${domainHue(domain)} 65% 50%)` }} />
      <span className="truncate">{address}</span>
    </span>
  );
}

function Row({
  m,
  href,
  active,
  selected,
  onSelect,
  onStar,
}: {
  m: MessageSummary;
  href: string;
  active: boolean;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  onStar: () => void;
}) {
  const unread = !m.is_read;
  return (
    <li
      className={cx(
        'group relative flex border-b border-zinc-100 transition-colors dark:border-zinc-800/70',
        active
          ? 'bg-blue-50 dark:bg-blue-500/10'
          : selected
            ? 'bg-blue-50/50 dark:bg-blue-500/5'
            : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
      )}
    >
      {unread && <span className="absolute top-0 bottom-0 left-0 w-0.5 bg-blue-600" />}
      <div className="flex flex-col items-center gap-2 py-3 pl-3 sm:pl-4">
        <span className="mt-0.5 flex">
          <Checkbox checked={selected} onChange={onSelect} label="选择" />
        </span>
        <button
          onClick={onStar}
          aria-label={m.is_starred ? '取消星标' : '加星标'}
          className={cx(
            'transition-colors',
            m.is_starred ? 'text-amber-400' : 'text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400',
          )}
        >
          <Star className="size-4" fill={m.is_starred ? 'currentColor' : 'none'} />
        </button>
      </div>
      <Link to={href} className="min-w-0 flex-1 py-3 pr-3 pl-3 sm:pr-4">
        <div className="flex items-baseline gap-2">
          <span className={cx('truncate text-sm', unread ? 'font-semibold text-zinc-900 dark:text-white' : 'text-zinc-700 dark:text-zinc-300')}>
            {senderLabel(m.from_name, m.from_addr)}
          </span>
          <span className={cx('ml-auto shrink-0 text-xs tabular-nums', unread ? 'font-medium text-blue-600 dark:text-blue-400' : 'text-zinc-500')}>
            {shortTime(m.received_at)}
          </span>
        </div>
        <div className={cx('mt-0.5 truncate text-sm', unread ? 'font-medium text-zinc-900 dark:text-zinc-100' : 'text-zinc-700 dark:text-zinc-300')}>
          {m.subject || '(无主题)'}
        </div>
        <div className="mt-0.5 line-clamp-1 text-[13px] text-zinc-500">
          {m.status === 'failed' ? '⚠ 邮件解析失败，可下载原文查看' : m.status === 'pending' ? '正在处理…' : m.snippet || '\u00a0'}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <AddressChip address={m.address} />
          {m.attachment_count > 0 && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-zinc-500">
              <Paperclip className="size-3" />
              {m.attachment_count}
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}

export default function MessageList({ filter, selectedId }: { filter: ListFilter; selectedId: number | null }) {
  const { view, d, a, q } = filter;
  const [search, setSearch] = useSearchParams();
  const { openNav } = useNav();
  const run = useMessageActions();
  const { confirm, toast, error } = useFeedback();
  const qc = useQueryClient();
  const list = useMessageList(filter);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => setSelected(new Set()), [view, d, a, q]);

  const [query, setQuery] = useState(q ?? '');
  useEffect(() => setQuery(q ?? ''), [q]);
  const submitSearch = (value: string) => {
    const next = new URLSearchParams(search);
    if (value.trim()) next.set('q', value.trim());
    else next.delete('q');
    setSearch(next);
  };

  const clearFilter = () => {
    const next = new URLSearchParams(search);
    next.delete('d');
    next.delete('a');
    setSearch(next);
  };

  // Infinite scroll
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [list]);

  const qs = search.toString();
  const hrefFor = (id: number) => `/mail/${view}/${id}${qs ? `?${qs}` : ''}`;

  const ids = [...selected];
  const allSelected = items.length > 0 && items.every((m) => selected.has(m.id));
  const toggleAll = (checked: boolean) => setSelected(checked ? new Set(items.map((m) => m.id)) : new Set());

  const bulk = async (action: BatchAction) => {
    if (action === 'delete') {
      const ok = await confirm({
        title: '彻底删除',
        message: `将永久删除选中的 ${ids.length} 封邮件及其附件，无法恢复。`,
        confirmText: '彻底删除',
        danger: true,
      });
      if (!ok) return;
    }
    await run(ids, action);
    setSelected(new Set());
  };

  const emptyFolder = async () => {
    const label = VIEW_LABELS[view];
    const ok = await confirm({
      title: `清空${label}`,
      message: `将永久删除${label}中${d || a ? '当前筛选范围内你可见的' : '你可见的'}所有邮件，无法恢复。`,
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    try {
      let total = 0;
      for (;;) {
        const res = await post<{ deleted: number; more: boolean }>('/mail/messages/empty', { folder: view, domain: d, address: a });
        total += res.deleted;
        if (!res.more) break;
      }
      toast(`已删除 ${total} 封邮件`);
    } catch (err) {
      error(err);
    } finally {
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['mailboxes'] });
    }
  };

  const inTrashOrSpam = view === 'trash' || view === 'spam';
  const filterLabel = a ?? d;

  return (
    <div className="flex h-full flex-col bg-white dark:bg-zinc-900">
      <div className="shrink-0 border-b border-zinc-200 pt-[env(safe-area-inset-top)] dark:border-zinc-800">
        <div className="flex h-14 items-center gap-1 px-2 sm:px-3">
          <IconButton label="菜单" onClick={openNav} className="lg:hidden">
            <Menu className="size-5" />
          </IconButton>
          <h1 className="truncate px-1 text-base font-semibold">{VIEW_LABELS[view]}</h1>
          {filterLabel && (
            <span className="ml-1 inline-flex min-w-0 items-center gap-1 rounded-full bg-zinc-100 py-0.5 pr-1 pl-2.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              <span className="truncate">{filterLabel}</span>
              <button onClick={clearFilter} aria-label="清除筛选" className="rounded-full p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700">
                <X className="size-3" />
              </button>
            </span>
          )}
          <div className="ml-auto flex items-center">
            {inTrashOrSpam && items.length > 0 && (
              <Button size="sm" variant="ghost" onClick={emptyFolder}>
                清空
              </Button>
            )}
            <IconButton label="刷新" onClick={() => list.refetch()}>
              <RefreshCw className={cx('size-4', list.isRefetching && 'animate-spin')} />
            </IconButton>
          </div>
        </div>
        <form
          className="px-3 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            submitSearch(query);
          }}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!e.target.value && q) submitSearch('');
              }}
              placeholder="搜索主题、发件人、正文"
              className="h-9 w-full rounded-lg border-0 bg-zinc-100 pr-3 pl-9 text-sm placeholder:text-zinc-500 focus:bg-white focus:ring-2 focus:ring-blue-600 focus:outline-none dark:bg-zinc-800 dark:focus:bg-zinc-900"
            />
          </div>
        </form>
        {items.length > 0 && (
          <div className="flex h-10 items-center gap-1 border-t border-zinc-100 px-3 sm:px-4 dark:border-zinc-800/70">
            <Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={toggleAll} label="全选" />
            {selected.size === 0 ? (
              <span className="ml-2 text-xs text-zinc-500">
                {list.hasNextPage ? `已加载 ${items.length} 封` : `共 ${items.length} 封`}
              </span>
            ) : (
              <div className="ml-2 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
                <span className="mr-1 shrink-0 text-xs text-zinc-500">已选 {selected.size}</span>
                <Button size="sm" variant="ghost" onClick={() => bulk('read')}>已读</Button>
                <Button size="sm" variant="ghost" onClick={() => bulk('unread')}>未读</Button>
                {view !== 'archive' && !inTrashOrSpam && <Button size="sm" variant="ghost" onClick={() => bulk('archive')}>归档</Button>}
                {(view === 'archive' || inTrashOrSpam) && <Button size="sm" variant="ghost" onClick={() => bulk('inbox')}>移回收件箱</Button>}
                {view !== 'spam' && <Button size="sm" variant="ghost" onClick={() => bulk('spam')}>垃圾</Button>}
                {inTrashOrSpam ? (
                  <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => bulk('delete')}>彻底删除</Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => bulk('trash')}>删除</Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="pane-scroll flex-1 overflow-y-auto">
        {list.isPending ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : list.isError ? (
          <Empty title="加载失败">{list.error.message}</Empty>
        ) : items.length === 0 ? (
          <Empty icon={<Inbox className="size-10" strokeWidth={1.25} />} title={q ? '没有找到匹配的邮件' : '这里没有邮件'}>
            {q ? '少于 3 个字的关键词只匹配主题和发件人。' : null}
          </Empty>
        ) : (
          <ul>
            {items.map((m) => (
              <Row
                key={m.id}
                m={m}
                href={hrefFor(m.id)}
                active={m.id === selectedId}
                selected={selected.has(m.id)}
                onSelect={(checked) =>
                  setSelected((s) => {
                    const next = new Set(s);
                    if (checked) next.add(m.id);
                    else next.delete(m.id);
                    return next;
                  })
                }
                onStar={() => run([m.id], m.is_starred ? 'unstar' : 'star', { silent: true })}
              />
            ))}
          </ul>
        )}
        <div ref={sentinel} className="flex h-12 items-center justify-center">
          {list.isFetchingNextPage && <Spinner className="size-4" />}
        </div>
      </div>
    </div>
  );
}
