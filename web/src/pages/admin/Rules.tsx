import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, del, post, type BlockedSender, type Forward } from '../../api';
import { useFeedback } from '../../components/feedback';
import { Button, Card, Empty, IconButton, Input, PageHeader, Spinner } from '../../components/ui';
import PageShell from '../PageShell';

function ForwardsCard() {
  const qc = useQueryClient();
  const { confirm, toast, error } = useFeedback();
  const [form, setForm] = useState({ source: '', destination: '' });
  const { data, isPending } = useQuery({ queryKey: ['admin', 'forwards'], queryFn: () => api<{ forwards: Forward[] }>('/admin/forwards') });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/admin/forwards', form);
      setForm({ source: '', destination: '' });
      toast('已添加转发');
      qc.invalidateQueries({ queryKey: ['admin', 'forwards'] });
    } catch (err) {
      error(err);
    }
  };

  const remove = async (f: Forward) => {
    if (!(await confirm({ title: '删除转发', message: `不再把 ${f.source} 的邮件转发到 ${f.destination}。`, confirmText: '删除', danger: true }))) return;
    try {
      await del(`/admin/forwards/${f.id}`);
      qc.invalidateQueries({ queryKey: ['admin', 'forwards'] });
    } catch (err) {
      error(err);
    }
  };

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">转发</h2>
      <p className="mb-3 text-[13px] leading-relaxed text-zinc-500">
        邮件存入本系统的同时，再转发一份到其他邮箱。目标地址必须先在 Cloudflare 的「电子邮件路由 → 目标地址」中验证，否则转发会失败。来源可以填 <code>*@域名</code> 来匹配整个域名。
      </p>
      <Card>
        <form onSubmit={add} className="flex flex-wrap gap-2 border-b border-zinc-100 p-3 dark:border-zinc-800">
          <Input required placeholder="来源，如 info@a.com 或 *@a.com" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} className="min-w-48 flex-1" />
          <Input required type="email" placeholder="转发到" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} className="min-w-48 flex-1" />
          <Button type="submit" variant="primary">
            添加
          </Button>
        </form>
        {isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : !data?.forwards.length ? (
          <Empty title="没有转发规则" />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data.forwards.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 truncate font-medium">{f.source}</span>
                <ArrowRight className="size-3.5 shrink-0 text-zinc-400" />
                <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-400">{f.destination}</span>
                <IconButton label="删除" onClick={() => remove(f)} className="hover:text-red-600">
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function BlocklistCard() {
  const qc = useQueryClient();
  const { error, toast } = useFeedback();
  const [form, setForm] = useState({ pattern: '', note: '' });
  const { data, isPending } = useQuery({ queryKey: ['admin', 'blocklist'], queryFn: () => api<{ blocked: BlockedSender[] }>('/admin/blocklist') });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/admin/blocklist', form);
      setForm({ pattern: '', note: '' });
      toast('已加入拦截列表');
      qc.invalidateQueries({ queryKey: ['admin', 'blocklist'] });
    } catch (err) {
      error(err);
    }
  };

  const remove = async (b: BlockedSender) => {
    try {
      await del(`/admin/blocklist/${encodeURIComponent(b.pattern)}`);
      qc.invalidateQueries({ queryKey: ['admin', 'blocklist'] });
    } catch (err) {
      error(err);
    }
  };

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">拦截发件人</h2>
      <p className="mb-3 text-[13px] text-zinc-500">列表中的发件人发来的邮件会在投递时直接拒收，不会进入系统。填 @域名 可以拦截整个域名。</p>
      <Card>
        <form onSubmit={add} className="flex flex-wrap gap-2 border-b border-zinc-100 p-3 dark:border-zinc-800">
          <Input required placeholder="spam@example.com 或 @example.com" value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} className="min-w-48 flex-1" />
          <Input placeholder="备注（可选）" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="min-w-32 flex-1" />
          <Button type="submit" variant="primary">
            拦截
          </Button>
        </form>
        {isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : !data?.blocked.length ? (
          <Empty title="没有拦截的发件人" />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data.blocked.map((b) => (
              <li key={b.pattern} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 truncate font-medium">{b.pattern}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-500">{b.note}</span>
                <IconButton label="移除" onClick={() => remove(b)} className="hover:text-red-600">
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

export default function RulesPage() {
  return (
    <PageShell title="转发与拦截">
      <PageHeader title="转发与拦截" description="控制邮件进入系统后是否抄送到其他邮箱，以及哪些发件人直接拒收。" />
      <div className="space-y-8">
        <ForwardsCard />
        <BlocklistCard />
      </div>
    </PageShell>
  );
}
