import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CircleAlert, CircleCheck, Pencil, Plus, Send, Smartphone, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api, del, patch, post, put, type AdminDomain, type BarkTarget, type NotifyRule, type RuleField } from '../../api';
import { useFeedback } from '../../components/feedback';
import { Badge, Button, Card, cx, Empty, Field, IconButton, Input, Modal, PageHeader, Spinner } from '../../components/ui';
import { relativeTime } from '../../lib/format';
import PageShell from '../PageShell';

interface BarkResponse {
  targets: BarkTarget[];
  rules: NotifyRule[];
  publicUrl: string | null;
}

const FIELD_LABELS: Record<RuleField, string> = { subject: '主题', from: '发件人', body: '正文' };

function useBark() {
  return useQuery({ queryKey: ['admin', 'bark'], queryFn: () => api<BarkResponse>('/admin/bark') });
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-700',
      )}
    >
      <span className={cx('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  );
}

function TargetsCard({ targets }: { targets: BarkTarget[] }) {
  const qc = useQueryClient();
  const { toast, error, confirm } = useFeedback();
  const [form, setForm] = useState({ name: '', key: '', server: '' });
  const [custom, setCustom] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'bark'] });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/admin/bark', { name: form.name, key: form.key, server: custom ? form.server : undefined });
      setForm({ name: '', key: '', server: '' });
      toast('已添加设备，可以点「测试」确认能收到');
      refresh();
    } catch (err) {
      error(err);
    }
  };

  const test = async (t: BarkTarget) => {
    setTesting(t.id);
    try {
      await post(`/admin/bark/${t.id}/test`);
      toast(`已推送到 ${t.name}，请查看手机`);
    } catch (err) {
      error(err);
    } finally {
      setTesting(null);
      refresh();
    }
  };

  const remove = async (t: BarkTarget) => {
    if (!(await confirm({ title: '删除设备', message: `删除「${t.name}」？引用它的规则将不再推送到这台设备。`, confirmText: '删除', danger: true }))) return;
    try {
      await del(`/admin/bark/${t.id}`);
      refresh();
    } catch (err) {
      error(err);
    }
  };

  const setEnabled = async (t: BarkTarget, enabled: boolean) => {
    try {
      await patch(`/admin/bark/${t.id}`, { enabled });
      refresh();
    } catch (err) {
      error(err);
    }
  };

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Bark 设备</h2>
      <p className="mb-3 text-[13px] text-zinc-500">在 iPhone 上安装 Bark App，复制首页的推送链接（形如 https://api.day.app/你的Key/），粘贴到下面。可以添加多台设备。</p>
      <Card>
        <form onSubmit={add} className="space-y-2 border-b border-zinc-100 p-3 dark:border-zinc-800">
          <div className="flex flex-wrap gap-2">
            <Input placeholder="名称，如 我的 iPhone" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="min-w-32 flex-1 sm:max-w-48" />
            <Input
              required
              placeholder="Bark 推送链接或设备 Key"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              className="min-w-56 flex-[2]"
            />
            <Button type="submit" variant="primary">
              <Plus className="size-4" />
              添加
            </Button>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-zinc-500">
            <input type="checkbox" className="size-3.5 accent-blue-600" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
            使用自建 Bark 服务器（只填 Key 时需要）
          </label>
          {custom && (
            <Input placeholder="https://bark.example.com" value={form.server} onChange={(e) => setForm({ ...form, server: e.target.value })} />
          )}
        </form>
        {targets.length === 0 ? (
          <Empty icon={<Smartphone className="size-8" strokeWidth={1.25} />} title="还没有设备" />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {targets.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <Toggle checked={t.enabled} onChange={(v) => setEnabled(t, v)} label={t.enabled ? '停用' : '启用'} />
                <div className="min-w-0 flex-1 basis-40">
                  <div className={cx('truncate text-sm font-medium', !t.enabled && 'text-zinc-400')}>{t.name}</div>
                  <div className="truncate text-xs text-zinc-500">
                    {new URL(t.server).host} · {t.key}
                  </div>
                </div>
                <div className="text-xs text-zinc-500">
                  {t.last_sent_at ? (
                    t.last_error ? (
                      <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400" title={t.last_error}>
                        <CircleAlert className="size-3.5" />
                        失败 · {relativeTime(t.last_sent_at)}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                        <CircleCheck className="size-3.5" />
                        {relativeTime(t.last_sent_at)}推送成功
                      </span>
                    )
                  ) : (
                    '尚未推送'
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" loading={testing === t.id} onClick={() => test(t)}>
                    <Send className="size-3.5" />
                    测试
                  </Button>
                  <IconButton label="删除" onClick={() => remove(t)} className="hover:text-red-600">
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

interface RuleForm {
  name: string;
  keywords: string;
  fields: RuleField[];
  scopes: string[];
  require_code: boolean;
  target_ids: number[];
  enabled: boolean;
}

function RuleDialog({ rule, targets, onClose }: { rule: NotifyRule | 'new'; targets: BarkTarget[]; onClose: () => void }) {
  const isNew = rule === 'new';
  const qc = useQueryClient();
  const { toast, error } = useFeedback();
  const domains = useQuery({ queryKey: ['admin', 'domains'], queryFn: () => api<{ domains: AdminDomain[] }>('/admin/domains') });
  const [form, setForm] = useState<RuleForm>(
    isNew
      ? { name: '', keywords: '', fields: ['subject', 'from', 'body'], scopes: [], require_code: false, target_ids: targets.map((t) => t.id), enabled: true }
      : { ...rule, keywords: rule.keywords.join('\n') },
  );
  const [scopeDraft, setScopeDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const addScope = () => {
    const v = scopeDraft.trim().toLowerCase();
    if (v && !form.scopes.includes(v)) setForm({ ...form, scopes: [...form.scopes, v] });
    setScopeDraft('');
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const body = { ...form, keywords: form.keywords.split(/[\n,，、]+/).map((k) => k.trim()).filter(Boolean) };
    try {
      if (isNew) await post('/admin/notify-rules', body);
      else await put(`/admin/notify-rules/${rule.id}`, body);
      toast('规则已保存');
      qc.invalidateQueries({ queryKey: ['admin', 'bark'] });
      onClose();
    } catch (err) {
      error(err);
    } finally {
      setSaving(false);
    }
  };

  const domainNames = domains.data?.domains.map((d) => d.name) ?? [];

  return (
    <Modal
      open
      wide
      title={isNew ? '新建推送规则' : '编辑推送规则'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" form="rule-form" loading={saving}>
            保存
          </Button>
        </>
      }
    >
      <form id="rule-form" onSubmit={save} className="space-y-5">
        <Field label="规则名称">
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：验证码、发票、服务器告警" />
        </Field>

        <Field label="关键词" hint="每行一个，也可以用逗号分隔。命中任意一个就推送；留空表示所有邮件。不区分大小写。">
          <textarea
            rows={3}
            value={form.keywords}
            onChange={(e) => setForm({ ...form, keywords: e.target.value })}
            placeholder={'发票\ninvoice\n告警'}
            className="block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm ring-1 ring-zinc-300 ring-inset placeholder:text-zinc-400 focus:ring-2 focus:ring-blue-600 focus:outline-none dark:bg-zinc-900 dark:ring-zinc-700"
          />
        </Field>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300">在哪里查找关键词</span>
          <div className="flex flex-wrap gap-4">
            {(Object.keys(FIELD_LABELS) as RuleField[]).map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-blue-600" checked={form.fields.includes(f)} onChange={() => setForm({ ...form, fields: toggle(form.fields, f) })} />
                {FIELD_LABELS[f]}
              </label>
            ))}
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-blue-600" checked={form.require_code} onChange={(e) => setForm({ ...form, require_code: e.target.checked })} />
          <span>
            只推送带验证码的邮件
            <span className="block text-xs text-zinc-500">推送时验证码会自动复制到 iPhone 剪贴板</span>
          </span>
        </label>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300">适用范围</span>
          <p className="mb-2 text-xs text-zinc-500">不选表示所有域名。也可以填写单个地址。</p>
          <div className="flex flex-wrap gap-1.5">
            {domainNames.map((d) => (
              <button
                type="button"
                key={d}
                onClick={() => setForm({ ...form, scopes: toggle(form.scopes, d) })}
                className={
                  form.scopes.includes(d)
                    ? 'rounded-full bg-blue-600 px-3 py-1 text-[13px] text-white'
                    : 'rounded-full px-3 py-1 text-[13px] text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-50 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800'
                }
              >
                {d}
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Input
              value={scopeDraft}
              onChange={(e) => setScopeDraft(e.target.value)}
              placeholder="单个地址，如 admin@example.com"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addScope();
                }
              }}
            />
            <Button onClick={addScope}>添加</Button>
          </div>
          {form.scopes.filter((s) => !domainNames.includes(s)).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {form.scopes
                .filter((s) => !domainNames.includes(s))
                .map((s) => (
                  <span key={s} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 py-0.5 pr-1 pl-2.5 text-[13px] dark:bg-zinc-800">
                    {s}
                    <button type="button" aria-label={`移除 ${s}`} onClick={() => setForm({ ...form, scopes: form.scopes.filter((x) => x !== s) })} className="rounded-full p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700">
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
            </div>
          )}
        </div>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300">推送到</span>
          {targets.length === 0 ? (
            <p className="text-sm text-amber-600">先在上方添加 Bark 设备。</p>
          ) : (
            <div className="flex flex-wrap gap-4">
              {targets.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-blue-600" checked={form.target_ids.includes(t.id)} onChange={() => setForm({ ...form, target_ids: toggle(form.target_ids, t.id) })} />
                  {t.name}
                  {!t.enabled && <span className="text-xs text-zinc-400">（已停用）</span>}
                </label>
              ))}
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}

function describeRule(r: NotifyRule): string {
  const parts: string[] = [];
  parts.push(r.keywords.length ? `关键词：${r.keywords.join('、')}` : '所有邮件');
  if (r.keywords.length && r.fields.length < 3) parts.push(`查找${r.fields.map((f) => FIELD_LABELS[f]).join('、')}`);
  if (r.require_code) parts.push('仅含验证码');
  parts.push(r.scopes.length ? `范围：${r.scopes.join('、')}` : '全部域名');
  return parts.join(' · ');
}

function RulesCard({ rules, targets }: { rules: NotifyRule[]; targets: BarkTarget[] }) {
  const qc = useQueryClient();
  const { toast, error, confirm } = useFeedback();
  const [editing, setEditing] = useState<NotifyRule | 'new' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'bark'] });
  const targetName = (id: number) => targets.find((t) => t.id === id)?.name;

  const addPreset = async () => {
    try {
      await post('/admin/notify-rules', { name: '验证码', keywords: [], require_code: true, target_ids: targets.map((t) => t.id) });
      toast('已添加：所有带验证码的邮件都会推送');
      refresh();
    } catch (err) {
      error(err);
    }
  };

  const setEnabled = async (r: NotifyRule, enabled: boolean) => {
    try {
      await patch(`/admin/notify-rules/${r.id}`, { enabled });
      refresh();
    } catch (err) {
      error(err);
    }
  };

  const remove = async (r: NotifyRule) => {
    if (!(await confirm({ title: '删除规则', message: `删除规则「${r.name}」？`, confirmText: '删除', danger: true }))) return;
    try {
      await del(`/admin/notify-rules/${r.id}`);
      refresh();
    } catch (err) {
      error(err);
    }
  };

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">推送规则</h2>
        <Button size="sm" variant="primary" disabled={targets.length === 0} onClick={() => setEditing('new')}>
          <Plus className="size-4" />
          新建规则
        </Button>
      </div>
      <p className="mb-3 text-[13px] text-zinc-500">新邮件命中任意一条规则就会推送，同一封邮件对同一台设备只推一次。垃圾邮件不推送。</p>
      <Card>
        {rules.length === 0 ? (
          <Empty icon={<BellRing className="size-8" strokeWidth={1.25} />} title="还没有推送规则">
            {targets.length > 0 ? (
              <Button size="sm" className="mt-3" onClick={addPreset}>
                一键添加「验证码推送」
              </Button>
            ) : (
              '先添加 Bark 设备。'
            )}
          </Empty>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <Toggle checked={r.enabled} onChange={(v) => setEnabled(r, v)} label={r.enabled ? '停用' : '启用'} />
                <div className="min-w-0 flex-1 basis-56">
                  <div className={cx('text-sm font-medium', !r.enabled && 'text-zinc-400')}>{r.name}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">{describeRule(r)}</div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {r.target_ids.map((id) => (
                    <Badge key={id} tone={targetName(id) ? 'blue' : 'red'}>
                      {targetName(id) ?? '已删除的设备'}
                    </Badge>
                  ))}
                </div>
                <div className="flex shrink-0">
                  <IconButton label="编辑" onClick={() => setEditing(r)}>
                    <Pencil className="size-4" />
                  </IconButton>
                  <IconButton label="删除" onClick={() => remove(r)} className="hover:text-red-600">
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && <RuleDialog rule={editing} targets={targets} onClose={() => setEditing(null)} />}
    </section>
  );
}

export default function NotifyPage() {
  const { data, isPending } = useBark();
  return (
    <PageShell title="Bark 推送">
      <PageHeader title="Bark 推送" description="收到命中关键词的邮件时推送到手机。验证码会自动复制，点开通知直接打开这封邮件。" />
      {isPending || !data ? (
        <Spinner />
      ) : (
        <div className="space-y-8">
          <TargetsCard targets={data.targets} />
          <RulesCard rules={data.rules} targets={data.targets} />
        </div>
      )}
    </PageShell>
  );
}
