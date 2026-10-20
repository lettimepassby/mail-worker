import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api, del, patch, post, type AccessEntry, type AdminAddress, type AdminDomain, type AdminUser, type Role } from '../../api';
import { useFeedback } from '../../components/feedback';
import { Badge, Button, Card, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Spinner } from '../../components/ui';
import { avatarStyle, initial, relativeTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import PageShell from '../PageShell';

interface FormState {
  email: string;
  name: string;
  password: string;
  role: Role;
  disabled: boolean;
  access: AccessEntry[];
}

const EMPTY: FormState = { email: '', name: '', password: '', role: 'member', disabled: false, access: [] };

function AccessEditor({ value, onChange }: { value: AccessEntry[]; onChange: (v: AccessEntry[]) => void }) {
  const domains = useQuery({ queryKey: ['admin', 'domains'], queryFn: () => api<{ domains: AdminDomain[] }>('/admin/domains') });
  const addresses = useQuery({ queryKey: ['admin', 'addresses', ''], queryFn: () => api<{ addresses: AdminAddress[] }>('/admin/addresses') });
  const [draft, setDraft] = useState('');

  const hasDomain = (name: string) => value.some((a) => a.kind === 'domain' && a.value === name);
  const toggleDomain = (name: string) =>
    onChange(hasDomain(name) ? value.filter((a) => !(a.kind === 'domain' && a.value === name)) : [...value, { kind: 'domain', value: name }]);
  const addressEntries = value.filter((a) => a.kind === 'address');
  const addAddress = () => {
    const v = draft.trim().toLowerCase();
    if (!v || addressEntries.some((a) => a.value === v)) return setDraft('');
    onChange([...value, { kind: 'address', value: v }]);
    setDraft('');
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300">可查看的整个域名</div>
        {domains.isPending ? (
          <Spinner className="size-4" />
        ) : domains.data?.domains.length ? (
          <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
            {domains.data.domains.map((d) => (
              <button
                type="button"
                key={d.name}
                onClick={() => toggleDomain(d.name)}
                className={
                  hasDomain(d.name)
                    ? 'rounded-full bg-blue-600 px-3 py-1 text-[13px] text-white'
                    : 'rounded-full px-3 py-1 text-[13px] text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-50 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800'
                }
              >
                {d.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">还没有域名。</p>
        )}
      </div>
      <div>
        <div className="mb-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300">可查看的单个地址</div>
        <div className="flex gap-2">
          <Input
            list="known-addresses"
            value={draft}
            placeholder="name@example.com"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addAddress();
              }
            }}
          />
          <Button onClick={addAddress}>添加</Button>
        </div>
        <datalist id="known-addresses">
          {addresses.data?.addresses.map((a) => <option key={a.address} value={a.address} />)}
        </datalist>
        {addressEntries.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {addressEntries.map((a) => (
              <span key={a.value} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 py-0.5 pr-1 pl-2.5 text-[13px] dark:bg-zinc-800">
                {a.value}
                <button
                  type="button"
                  aria-label={`移除 ${a.value}`}
                  onClick={() => onChange(value.filter((x) => !(x.kind === 'address' && x.value === a.value)))}
                  className="rounded-full p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function UserDialog({ user, onClose }: { user: AdminUser | 'new'; onClose: () => void }) {
  const isNew = user === 'new';
  const me = useSession();
  const qc = useQueryClient();
  const { toast, error } = useFeedback();
  const [form, setForm] = useState<FormState>(
    isNew ? EMPTY : { email: user.email, name: user.name, password: '', role: user.role, disabled: user.disabled, access: user.access },
  );
  const [saving, setSaving] = useState(false);
  const isSelf = !isNew && user.id === me.id;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { ...form, access: form.role === 'admin' ? [] : form.access };
      if (isNew) await post('/admin/users', body);
      else await patch(`/admin/users/${user.id}`, { name: body.name, role: body.role, disabled: body.disabled, access: body.access, password: body.password || undefined });
      toast(isNew ? '用户已创建' : '已保存');
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
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
      title={isNew ? '新建用户' : '编辑用户'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" form="user-form" loading={saving}>
            保存
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="登录名（邮箱格式）">
            <Input type="email" required disabled={!isNew} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="姓名">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={isNew ? '初始密码' : '重置密码'} hint={isNew ? '至少 8 位' : '留空则不修改；修改后该用户需重新登录'}>
            <Input
              type="password"
              autoComplete="new-password"
              required={isNew}
              minLength={8}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          <Field label="角色">
            <Select className="w-full" value={form.role} disabled={isSelf} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="member">成员：只能看分配的邮箱</option>
              <option value="admin">管理员：可看全部并管理</option>
            </Select>
          </Field>
        </div>
        {!isNew && !isSelf && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-blue-600" checked={form.disabled} onChange={(e) => setForm({ ...form, disabled: e.target.checked })} />
            停用此账号（立即退出所有设备）
          </label>
        )}
        {form.role === 'member' && (
          <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/40">
            <AccessEditor value={form.access} onChange={(access) => setForm({ ...form, access })} />
          </div>
        )}
      </form>
    </Modal>
  );
}

export default function UsersPage() {
  const me = useSession();
  const qc = useQueryClient();
  const { confirm, toast, error } = useFeedback();
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);
  const { data, isPending } = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<{ users: AdminUser[] }>('/admin/users') });

  const remove = async (u: AdminUser) => {
    const ok = await confirm({ title: '删除用户', message: `确定删除 ${u.email}？邮件不受影响。`, confirmText: '删除', danger: true });
    if (!ok) return;
    try {
      await del(`/admin/users/${u.id}`);
      toast('已删除');
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    } catch (err) {
      error(err);
    }
  };

  return (
    <PageShell title="用户与权限">
      <PageHeader
        title="用户与权限"
        description="管理员能看全部邮件；成员只能看到分配给他们的域名或地址。"
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus className="size-4" />
            新建用户
          </Button>
        }
      />

      <Card>
        {isPending ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : !data?.users.length ? (
          <Empty title="还没有用户" />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data.users.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:flex-nowrap">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white" style={avatarStyle(u.email)}>
                  {initial(u.name, u.email)}
                </div>
                <div className="min-w-0 flex-1 basis-40">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{u.name || u.email}</span>
                    {u.id === me.id && <Badge>我</Badge>}
                    {u.role === 'admin' && <Badge tone="blue">管理员</Badge>}
                    {u.disabled && <Badge tone="red">已停用</Badge>}
                  </div>
                  <div className="truncate text-[13px] text-zinc-500">{u.email}</div>
                </div>
                <div className="order-last flex min-w-0 basis-full flex-wrap gap-1 sm:order-none sm:basis-64">
                  {u.role === 'admin' ? (
                    <span className="text-[13px] text-zinc-500">全部邮箱</span>
                  ) : u.access.length === 0 ? (
                    <span className="text-[13px] text-amber-600">未分配邮箱</span>
                  ) : (
                    <>
                      {u.access.slice(0, 4).map((a) => (
                        <Badge key={`${a.kind}:${a.value}`} tone={a.kind === 'domain' ? 'blue' : 'zinc'}>
                          {a.kind === 'domain' ? `@${a.value}` : a.value}
                        </Badge>
                      ))}
                      {u.access.length > 4 && <Badge>+{u.access.length - 4}</Badge>}
                    </>
                  )}
                </div>
                <div className="hidden w-24 shrink-0 text-right text-xs text-zinc-500 md:block" title="最近登录">
                  {relativeTime(u.last_login_at)}
                </div>
                <div className="flex shrink-0">
                  <IconButton label="编辑" onClick={() => setEditing(u)}>
                    <Pencil className="size-4" />
                  </IconButton>
                  {u.id !== me.id && (
                    <IconButton label="删除" onClick={() => remove(u)} className="hover:text-red-600">
                      <Trash2 className="size-4" />
                    </IconButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && <UserDialog user={editing} onClose={() => setEditing(null)} />}
    </PageShell>
  );
}
