import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  BellRing,
  ChevronRight,
  Gauge,
  Globe,
  Inbox,
  LogOut,
  Mail,
  Mails,
  Settings,
  ShieldAlert,
  ShieldBan,
  Star,
  Trash2,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api, buildQuery, post, type AuthState, type MailboxDomain, type Mailboxes, type UsageReport, type View } from '../api';
import { domainHue } from '../lib/format';
import { fallbackInterval, useRealtimeStatus } from '../lib/realtime';
import { useSession } from '../lib/session';
import { cx, Input } from './ui';

const FOLDERS: { view: View; label: string; icon: LucideIcon; count?: 'inbox' | 'spam' }[] = [
  { view: 'inbox', label: '收件箱', icon: Inbox, count: 'inbox' },
  { view: 'starred', label: '星标邮件', icon: Star },
  { view: 'all', label: '全部邮件', icon: Mails },
  { view: 'archive', label: '已归档', icon: Archive },
  { view: 'spam', label: '垃圾邮件', icon: ShieldAlert, count: 'spam' },
  { view: 'trash', label: '回收站', icon: Trash2 },
];

const ADDRESS_PREVIEW = 8;

export function useMailboxes() {
  return useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api<Mailboxes>('/mail/mailboxes'),
    refetchInterval: fallbackInterval,
  });
}

function Count({ n, strong }: { n: number; strong?: boolean }) {
  if (!n) return null;
  return (
    <span
      className={cx(
        'ml-auto min-w-5 rounded-full px-1.5 text-center text-xs leading-5 tabular-nums',
        strong ? 'bg-blue-600 font-semibold text-white' : 'text-zinc-500',
      )}
    >
      {n > 999 ? '999+' : n}
    </span>
  );
}

function NavItem({
  to,
  active,
  icon: Icon,
  label,
  children,
}: {
  to: string;
  active: boolean;
  icon: LucideIcon;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cx(
        'flex h-9 items-center gap-3 rounded-lg px-3 text-sm transition-colors',
        active
          ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
          : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
      )}
    >
      <Icon className="size-[18px] shrink-0" strokeWidth={active ? 2.2 : 1.8} />
      <span className="truncate">{label}</span>
      {children}
    </Link>
  );
}

function DomainNode({
  domain,
  view,
  activeDomain,
  activeAddress,
}: {
  domain: MailboxDomain;
  view: string;
  activeDomain: string | null;
  activeAddress: string | null;
}) {
  const containsActive = activeDomain === domain.name || domain.addresses.some((a) => a.address === activeAddress);
  const [open, setOpen] = useState(containsActive);
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(
    () => [...domain.addresses].sort((a, b) => b.unread - a.unread || (b.lastReceivedAt ?? 0) - (a.lastReceivedAt ?? 0)),
    [domain.addresses],
  );
  const visible = showAll ? sorted : sorted.slice(0, ADDRESS_PREVIEW);
  const isActive = activeDomain === domain.name && !activeAddress;

  return (
    <li>
      <div
        className={cx(
          'group flex h-8 items-center rounded-lg text-sm',
          isActive ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
        )}
      >
        <button
          onClick={() => setOpen(!open)}
          aria-label={open ? '收起' : '展开'}
          aria-expanded={open}
          className="flex size-8 shrink-0 items-center justify-center text-zinc-400"
        >
          <ChevronRight className={cx('size-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        <Link to={`/mail/${view}${buildQuery({ d: domain.name })}`} className="flex min-w-0 flex-1 items-center gap-2 pr-2">
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: `hsl(${domainHue(domain.name)} 65% 50%)` }} />
          <span className={cx('truncate', domain.unread > 0 && 'font-medium text-zinc-900 dark:text-zinc-100')}>{domain.name}</span>
          <Count n={domain.unread} />
        </Link>
      </div>
      {open && (
        <ul className="mb-1 ml-[22px] border-l border-zinc-200 pl-2 dark:border-zinc-800">
          {visible.map((a) => (
            <li key={a.address}>
              <Link
                to={`/mail/${view}${buildQuery({ a: a.address })}`}
                title={a.address}
                className={cx(
                  'flex h-7 items-center gap-2 rounded-md px-2 text-[13px]',
                  activeAddress === a.address
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                  a.status === 'blocked' && 'line-through opacity-60',
                )}
              >
                <span className={cx('truncate', a.unread > 0 && 'font-medium text-zinc-900 dark:text-zinc-100')}>
                  {a.address.slice(0, a.address.lastIndexOf('@'))}
                </span>
                <Count n={a.unread} />
              </Link>
            </li>
          ))}
          {sorted.length > ADDRESS_PREVIEW && (
            <li>
              <button
                onClick={() => setShowAll(!showAll)}
                className="h-7 px-2 text-[13px] text-blue-600 hover:underline dark:text-blue-400"
              >
                {showAll ? '收起' : `显示全部 ${sorted.length} 个地址`}
              </button>
            </li>
          )}
          {sorted.length === 0 && <li className="px-2 py-1 text-xs text-zinc-400">暂无收信地址</li>}
        </ul>
      )}
    </li>
  );
}

function LiveBadge() {
  const status = useRealtimeStatus();
  const label = status === 'open' ? '实时' : status === 'connecting' ? '连接中' : '离线';
  const title =
    status === 'open' ? '实时连接正常，新邮件会立即出现' : status === 'connecting' ? '正在连接实时通道…' : '实时通道已断开，每分钟自动刷新一次';
  return (
    <span title={title} className="ml-auto inline-flex items-center gap-1.5 text-xs text-zinc-500">
      <span
        className={cx(
          'size-1.5 rounded-full',
          status === 'open' ? 'bg-emerald-500' : status === 'connecting' ? 'animate-pulse bg-amber-500' : 'bg-zinc-400',
        )}
      />
      {label}
    </span>
  );
}

/** Admins see a dot on 用量与清理 once storage passes 80% of the free plan. */
function useUsageAlert(enabled: boolean) {
  const { data } = useQuery({
    queryKey: ['admin', 'usage'],
    queryFn: () => api<UsageReport>('/admin/usage'),
    enabled,
    staleTime: 10 * 60_000,
  });
  if (!data) return false;
  return data.usage.d1Bytes / data.limits.d1Bytes > 0.8 || data.usage.r2Bytes / data.limits.r2Bytes > 0.8;
}

export default function Sidebar() {
  const user = useSession();
  const { data } = useMailboxes();
  const [search] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const usageAlert = useUsageAlert(user.role === 'admin');

  const inboxUnread = data?.folders.inbox ?? 0;
  useEffect(() => {
    document.title = inboxUnread ? `(${inboxUnread}) 邮件中心` : '邮件中心';
  }, [inboxUnread]);

  // Rendered by the layout route, so the child's :view param isn't visible via useParams.
  const onMail = location.pathname.startsWith('/mail/');
  const view = onMail ? location.pathname.split('/')[2] || 'inbox' : 'inbox';
  const d = onMail ? search.get('d') : null;
  const a = onMail ? search.get('a') : null;
  const filterQuery = buildQuery({ d, a });

  const domains = (data?.domains ?? []).filter((x) => !filter || x.name.includes(filter.toLowerCase()));

  const logout = async () => {
    await post('/auth/logout').catch(() => {});
    queryClient.clear();
    queryClient.setQueryData<AuthState>(['auth'], { needsSetup: false, user: null });
    navigate('/');
  };

  return (
    <div className="flex h-full flex-col pt-[env(safe-area-inset-top)]">
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-5">
        <div className="flex size-7 items-center justify-center rounded-lg bg-blue-600 text-white">
          <Mail className="size-4" strokeWidth={2.2} />
        </div>
        <span className="font-semibold tracking-tight">邮件中心</span>
        <LiveBadge />
      </div>

      <nav className="pane-scroll flex-1 overflow-y-auto px-3 pb-4">
        <div className="space-y-0.5">
          {FOLDERS.map((f) => (
            <NavItem key={f.view} to={`/mail/${f.view}${filterQuery}`} active={onMail && view === f.view} icon={f.icon} label={f.label}>
              {f.count && <Count n={data?.folders[f.count] ?? 0} strong={f.count === 'inbox'} />}
            </NavItem>
          ))}
        </div>

        <div className="mt-6 mb-1.5 flex items-center justify-between px-3">
          <span className="text-xs font-medium tracking-wide text-zinc-500">域名</span>
          <span className="text-xs text-zinc-400 tabular-nums">{data?.domains.length ?? ''}</span>
        </div>
        {(data?.domains.length ?? 0) > 8 && (
          <div className="mb-2 px-1">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="筛选域名" className="h-8 py-1 text-[13px]" />
          </div>
        )}
        <ul className="space-y-0.5">
          {domains.map((dm) => (
            <DomainNode key={dm.name} domain={dm} view={view} activeDomain={d} activeAddress={a} />
          ))}
          {data && data.domains.length === 0 && (
            <li className="px-3 py-2 text-xs leading-relaxed text-zinc-400">
              {user.role === 'admin' ? '还没有收到任何邮件。到「域名与接入」里接入域名。' : '管理员还没有给你分配邮箱。'}
            </li>
          )}
        </ul>

        {user.role === 'admin' && (
          <>
            <div className="mt-6 mb-1.5 px-3 text-xs font-medium tracking-wide text-zinc-500">管理</div>
            <div className="space-y-0.5">
              <NavItem to="/admin/domains" active={location.pathname === '/admin/domains'} icon={Globe} label="域名与接入" />
              <NavItem to="/admin/users" active={location.pathname === '/admin/users'} icon={Users} label="用户与权限" />
              <NavItem to="/admin/rules" active={location.pathname === '/admin/rules'} icon={ShieldBan} label="转发与拦截" />
              <NavItem to="/admin/notify" active={location.pathname === '/admin/notify'} icon={BellRing} label="Bark 推送" />
              <NavItem to="/admin/usage" active={location.pathname === '/admin/usage'} icon={Gauge} label="用量与清理">
                {usageAlert && <span className="ml-auto size-2 rounded-full bg-amber-500" title="存储接近免费额度" />}
              </NavItem>
            </div>
          </>
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-2 border-t border-zinc-200 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-zinc-800">
        <Link
          to="/settings"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <Settings className="size-4 shrink-0 text-zinc-500" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{user.name || user.email}</div>
            {user.name && <div className="truncate text-xs text-zinc-500">{user.email}</div>}
          </div>
        </Link>
        <button
          onClick={logout}
          title="退出登录"
          aria-label="退出登录"
          className="flex size-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </div>
  );
}
