import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Ban, ChevronRight, CircleCheck, CircleDashed, Plus, RefreshCw, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import {
  api,
  del,
  patch,
  post,
  type AdminAddress,
  type AdminDomain,
  type Zone,
  type ZoneDetail,
  type ZoneRule,
} from '../../api';
import { useFeedback } from '../../components/feedback';
import { Badge, Button, Card, cx, Empty, IconButton, Input, Modal, PageHeader, Select, Spinner } from '../../components/ui';
import { domainHue, relativeTime } from '../../lib/format';
import PageShell from '../PageShell';

interface DomainsResponse {
  domains: AdminDomain[];
  cloudflareConfigured: boolean;
  workerName: string;
}

function useDomains() {
  return useQuery({ queryKey: ['admin', 'domains'], queryFn: () => api<DomainsResponse>('/admin/domains') });
}

function describeAction(rule: ZoneRule | null): { text: string; tone: 'green' | 'zinc' | 'amber' } {
  if (!rule || !rule.enabled) return { text: '未设置', tone: 'zinc' };
  if (rule.managed) return { text: '已接入本系统', tone: 'green' };
  const a = rule.actions[0];
  if (a?.type === 'forward') return { text: `转发到 ${a.value?.join(', ')}`, tone: 'amber' };
  if (a?.type === 'drop') return { text: '丢弃', tone: 'zinc' };
  if (a?.type === 'worker') return { text: `其他 Worker：${a.value?.join(', ')}`, tone: 'amber' };
  return { text: '未知', tone: 'zinc' };
}

/** Forward rules that still bypass this system. */
const unmanagedForwards = (d: ZoneDetail) => d.rules.filter((r) => !r.managed && r.address && r.actions.every((a) => a.type === 'forward'));

function TakeoverDialog({ zone, rules, onClose }: { zone: Zone; rules: ZoneRule[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast, error } = useFeedback();
  const [picked, setPicked] = useState(new Set(rules.map((r) => r.id)));
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const res = await post<{ addresses: string[] }>(`/admin/cloudflare/zones/${zone.id}/takeover`, { ruleIds: [...picked] });
      toast(`已接管 ${res.addresses.length} 条规则`);
      qc.invalidateQueries({ queryKey: ['admin'] });
      qc.invalidateQueries({ queryKey: ['mailboxes'] });
      onClose();
    } catch (err) {
      error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      wide
      title={`接管 ${zone.name} 的转发规则`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} disabled={picked.size === 0} onClick={submit}>
            接管 {picked.size} 条
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        这些地址有单独的转发规则，邮件不会经过本系统。接管后规则改为发送到 Worker，邮件先存进本系统，再由 Worker 照常转发到原来的目标地址，原有转发不会中断。
      </p>
      <ul className="divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-800">
        {rules.map((r) => (
          <li key={r.id}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-blue-600"
                checked={picked.has(r.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(r.id);
                  else next.delete(r.id);
                  setPicked(next);
                }}
              />
              <span className="min-w-0 truncate font-medium">{r.address}</span>
              <ArrowRight className="size-3.5 shrink-0 text-zinc-400" />
              <span className="min-w-0 truncate text-zinc-500">{r.forwards.join(', ')}</span>
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function EnableDialog({ zone, detail, workerName, onClose }: { zone: Zone; detail: ZoneDetail; workerName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast, error } = useFeedback();
  const forwards = detail.catchAll?.enabled ? detail.catchAll.forwards : [];
  const [keepForward, setKeepForward] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await post(`/admin/cloudflare/zones/${zone.id}/enable`, { keepForward });
      toast(`${zone.name} 已接入`);
      qc.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    } catch (err) {
      error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={`接入 ${zone.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} onClick={submit}>
            接入
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        <p>
          {detail.routing?.enabled ? '' : '将启用该域名的 Email Routing（Cloudflare 会写入 MX/SPF 记录），并'}把 catch-all 规则改为发送到 Worker「{workerName}」。已有的单地址规则保持不变，之后可以再接管。
        </p>
        {forwards.length > 0 && (
          <label className="flex items-start gap-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
            <input type="checkbox" className="mt-1 size-4 accent-blue-600" checked={keepForward} onChange={(e) => setKeepForward(e.target.checked)} />
            <span>
              继续转发一份到 <b className="text-zinc-900 dark:text-zinc-100">{forwards.join(', ')}</b>
              <span className="block text-xs text-zinc-500">当前 catch-all 转发到这里。不勾选则只能在本系统查看。</span>
            </span>
          </label>
        )}
      </div>
    </Modal>
  );
}

function ZoneRow({ zone, workerName }: { zone: Zone; workerName: string }) {
  const [takeover, setTakeover] = useState<ZoneRule[] | null>(null);
  const [enabling, setEnabling] = useState(false);
  const detail = useQuery({
    queryKey: ['admin', 'zone', zone.id],
    queryFn: () => api<ZoneDetail>(`/admin/cloudflare/zones/${zone.id}`),
    staleTime: 60_000,
  });

  const d = detail.data;
  const pending = d ? unmanagedForwards(d) : [];
  const catchAll = describeAction(d?.catchAll ?? null);

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
        {d?.managed ? <CircleCheck className="size-4 shrink-0 text-emerald-500" /> : <CircleDashed className="size-4 shrink-0 text-zinc-400" />}
        <span className="truncate font-medium">{zone.name}</span>
        {zone.status !== 'active' && <Badge tone="amber">{zone.status}</Badge>}
      </div>
      <div className="flex min-w-0 basis-full flex-wrap items-center gap-1.5 text-[13px] sm:basis-auto">
        {detail.isPending ? (
          <Spinner className="size-4" />
        ) : detail.isError ? (
          <span className="text-red-600">{detail.error.message}</span>
        ) : (
          <>
            {!d?.routing?.enabled && <Badge>Email Routing 未启用</Badge>}
            <Badge tone={catchAll.tone} className="max-w-64">
              <span className="truncate">catch-all：{catchAll.text}</span>
            </Badge>
            {d && d.rules.length > 0 && (
              <Badge tone={pending.length ? 'amber' : 'zinc'}>
                {d.rules.length} 条地址规则{pending.length ? `，${pending.length} 条未接管` : ''}
              </Badge>
            )}
          </>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {d && pending.length > 0 && (
          <Button size="sm" onClick={() => setTakeover(pending)}>
            接管规则
          </Button>
        )}
        {d && !d.managed && (
          <Button size="sm" variant="primary" onClick={() => setEnabling(true)}>
            接入
          </Button>
        )}
      </div>
      {takeover && <TakeoverDialog zone={zone} rules={takeover} onClose={() => setTakeover(null)} />}
      {enabling && d && <EnableDialog zone={zone} detail={d} workerName={workerName} onClose={() => setEnabling(false)} />}
    </li>
  );
}

function CloudflareSection({ configured, workerName }: { configured: boolean; workerName: string }) {
  const zones = useQuery({
    queryKey: ['admin', 'zones'],
    queryFn: () => api<{ configured: boolean; zones: Zone[] }>('/admin/cloudflare/zones'),
    enabled: configured,
  });
  const qc = useQueryClient();

  if (!configured) {
    return (
      <Card className="p-5 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        <p className="font-medium text-zinc-900 dark:text-zinc-100">还没有配置 Cloudflare API Token</p>
        <p className="mt-2">配置后可以在这里一键接入账号下的所有域名。做法如下：</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            在 Cloudflare 控制台 → 我的个人资料 → API 令牌中创建自定义令牌。权限：区域 / Zone · 读取，区域 / Email Routing 规则 · 编辑，区域 / DNS · 编辑，区域 /
            区域设置 · 编辑。区域资源选择「所有区域」。
          </li>
          <li>
            在项目目录运行 <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-[12px] dark:bg-zinc-800">npx wrangler secret put CF_API_TOKEN</code>，然后粘贴令牌。
          </li>
        </ol>
        <p className="mt-3">
          也可以手动接入：在 Cloudflare 控制台进入域名 → 电子邮件 → 电子邮件路由 → 路由规则，把 Catch-all 设为「发送到 Worker」并选择 <b>{workerName}</b>。
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <span className="text-sm text-zinc-500">{zones.data ? `账号下 ${zones.data.zones.length} 个域名` : '加载中…'}</span>
        <IconButton label="刷新" onClick={() => qc.invalidateQueries({ queryKey: ['admin'] })}>
          <RefreshCw className={cx('size-4', zones.isFetching && 'animate-spin')} />
        </IconButton>
      </div>
      {zones.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : zones.isError ? (
        <Empty title="无法读取 Cloudflare 域名">{zones.error.message}</Empty>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {zones.data.zones.map((z) => (
            <ZoneRow key={z.id} zone={z} workerName={workerName} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AddressesPanel({ domain }: { domain: AdminDomain }) {
  const qc = useQueryClient();
  const { confirm, toast, error } = useFeedback();
  const [draft, setDraft] = useState('');
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'addresses', domain.name],
    queryFn: () => api<{ addresses: AdminAddress[] }>(`/admin/addresses?domain=${encodeURIComponent(domain.name)}`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin'] });
    qc.invalidateQueries({ queryKey: ['mailboxes'] });
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const local = draft.trim();
    if (!local) return;
    try {
      await post('/admin/addresses', { address: local.includes('@') ? local : `${local}@${domain.name}` });
      setDraft('');
      refresh();
    } catch (err) {
      error(err);
    }
  };

  const setStatus = async (a: AdminAddress, status: 'active' | 'blocked') => {
    try {
      await patch(`/admin/addresses/${encodeURIComponent(a.address)}`, { status });
      toast(status === 'blocked' ? `已屏蔽 ${a.address}，之后发来的邮件会被拒收` : `已恢复 ${a.address}`);
      refresh();
    } catch (err) {
      error(err);
    }
  };

  const remove = async (a: AdminAddress) => {
    const ok = await confirm({
      title: '移除地址',
      message:
        domain.policy === 'known_only'
          ? `移除后 ${a.address} 将无法收信（已有邮件保留）。`
          : `从地址列表移除 ${a.address}。已有邮件保留；该地址再收到邮件时会重新出现。`,
      confirmText: '移除',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/admin/addresses/${encodeURIComponent(a.address)}`);
      refresh();
    } catch (err) {
      error(err);
    }
  };

  return (
    <div className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <form onSubmit={add} className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="添加地址，例如 sales" className="pr-28" />
          <span className="pointer-events-none absolute top-1/2 right-3 max-w-24 -translate-y-1/2 truncate text-sm text-zinc-400">@{domain.name}</span>
        </div>
        <Button type="submit">
          <Plus className="size-4" />
          添加
        </Button>
      </form>
      {isPending ? (
        <Spinner className="size-4" />
      ) : !data?.addresses.length ? (
        <p className="text-[13px] text-zinc-500">还没有地址。</p>
      ) : (
        <ul className="space-y-0.5">
          {data.addresses.map((a) => (
            <li key={a.address} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px] hover:bg-white dark:hover:bg-zinc-900">
              <span className={cx('min-w-0 flex-1 truncate', a.status === 'blocked' && 'text-zinc-400 line-through')}>{a.address}</span>
              {a.status === 'blocked' && <Badge tone="red">已屏蔽</Badge>}
              <span className="hidden w-16 shrink-0 text-right text-zinc-500 tabular-nums sm:block">{a.message_count} 封</span>
              <span className="hidden w-20 shrink-0 text-right text-zinc-500 sm:block">{relativeTime(a.last_received_at)}</span>
              <div className="flex shrink-0">
                {a.status === 'active' ? (
                  <IconButton label="屏蔽（拒收）" onClick={() => setStatus(a, 'blocked')} className="size-7">
                    <Ban className="size-3.5" />
                  </IconButton>
                ) : (
                  <IconButton label="恢复" onClick={() => setStatus(a, 'active')} className="size-7">
                    <Undo2 className="size-3.5" />
                  </IconButton>
                )}
                <IconButton label="移除" onClick={() => remove(a)} className="size-7 hover:text-red-600">
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DomainRow({ domain }: { domain: AdminDomain }) {
  const qc = useQueryClient();
  const { toast, error } = useFeedback();
  const [open, setOpen] = useState(false);

  const setPolicy = async (policy: string) => {
    try {
      await patch(`/admin/domains/${encodeURIComponent(domain.name)}`, { policy });
      toast(policy === 'known_only' ? '已改为只接收列表中的地址' : '已改为接收所有地址');
      qc.invalidateQueries({ queryKey: ['admin', 'domains'] });
    } catch (err) {
      error(err);
    }
  };

  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-left" aria-expanded={open}>
          <ChevronRight className={cx('size-4 shrink-0 text-zinc-400 transition-transform', open && 'rotate-90')} />
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: `hsl(${domainHue(domain.name)} 65% 50%)` }} />
          <span className="truncate font-medium">{domain.name}</span>
        </button>
        <div className="flex items-center gap-4 text-[13px] text-zinc-500 tabular-nums">
          <span>{domain.address_count} 个地址</span>
          <span>{domain.message_count} 封</span>
          <span className="hidden w-20 sm:inline">{relativeTime(domain.last_received_at)}</span>
        </div>
        <Select value={domain.policy} onChange={(e) => setPolicy(e.target.value)} className="h-8 py-1 text-[13px]" aria-label="收信策略">
          <option value="accept_all">接收所有地址</option>
          <option value="known_only">仅接收列表中的地址</option>
        </Select>
      </div>
      {open && <AddressesPanel domain={domain} />}
    </li>
  );
}

export default function DomainsPage() {
  const { data, isPending } = useDomains();

  return (
    <PageShell title="域名与接入">
      <PageHeader title="域名与接入" description="把 Cloudflare 上的域名接入本系统，并管理每个域名的收信策略和地址。" />

      <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Cloudflare 域名</h2>
      {isPending ? <Spinner /> : <CloudflareSection configured={!!data?.cloudflareConfigured} workerName={data?.workerName ?? 'mail-worker'} />}

      <h2 className="mt-8 mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">收信域名</h2>
      <p className="mb-3 text-[13px] text-zinc-500">
        域名收到第一封邮件后会出现在这里。「接收所有地址」时任意前缀都能收信；改成「仅接收列表中的地址」后，其他地址会在投递阶段被直接拒收，可以挡掉大部分垃圾邮件。
      </p>
      <Card>
        {isPending ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : !data?.domains.length ? (
          <Empty title="还没有域名收到邮件" />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data.domains.map((d) => (
              <DomainRow key={d.name} domain={d} />
            ))}
          </ul>
        )}
      </Card>
    </PageShell>
  );
}
