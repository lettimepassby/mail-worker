import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, post, put, type UsageReport } from '../../api';
import { useFeedback } from '../../components/feedback';
import { Button, Card, cx, Field, Input, PageHeader, Spinner } from '../../components/ui';
import { fileSize } from '../../lib/format';
import PageShell from '../PageShell';

const compact = (n: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** Meter: the fill carries severity and the track is a lighter step of the same hue. */
function Meter({ label, used, limit, hint }: { label: string; used: number; limit: number; hint: string }) {
  const ratio = Math.min(used / limit, 1);
  const level = ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'warning' : 'ok';
  const styles = {
    ok: { track: 'bg-blue-100 dark:bg-blue-500/15', fill: 'bg-blue-600 dark:bg-blue-500', text: 'text-zinc-500', icon: CircleCheck, word: '正常' },
    warning: { track: 'bg-amber-100 dark:bg-amber-500/15', fill: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400', icon: TriangleAlert, word: '接近上限' },
    critical: { track: 'bg-red-100 dark:bg-red-500/15', fill: 'bg-red-600 dark:bg-red-500', text: 'text-red-700 dark:text-red-400', icon: CircleAlert, word: '即将用尽' },
  }[level];
  const Icon = styles.icon;
  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-zinc-600 dark:text-zinc-400">{label}</span>
        <span className={cx('inline-flex items-center gap-1 text-xs font-medium', styles.text)}>
          <Icon className="size-3.5" />
          {styles.word}
        </span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-white">
        {fileSize(used)}
        <span className="ml-1.5 text-sm font-normal text-zinc-500">/ {fileSize(limit)}</span>
      </div>
      <div
        className={cx('mt-3 h-2 overflow-hidden rounded-full', styles.track)}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        aria-valuetext={`${(ratio * 100).toFixed(1)}%`}
      >
        <div className={cx('h-full rounded-full', styles.fill)} style={{ width: `${Math.max(ratio * 100, used > 0 ? 1 : 0)}%` }} />
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        已用 {(ratio * 100).toFixed(1)}% · {hint}
      </p>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-sm text-zinc-600 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-white">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </Card>
  );
}

// Rough D1 rows written per received message: row + indexes, FTS shadow rows, attachments, counters.
const WRITES_PER_MESSAGE = 25;

export default function UsagePage() {
  const qc = useQueryClient();
  const { toast, error } = useFeedback();
  const { data, isPending } = useQuery({ queryKey: ['admin', 'usage'], queryFn: () => api<UsageReport>('/admin/usage') });
  const [settings, setSettings] = useState<UsageReport['settings'] | null>(null);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    if (data) setSettings(data.settings);
  }, [data]);

  if (isPending || !data || !settings) {
    return (
      <PageShell title="用量与清理">
        <Spinner />
      </PageShell>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayRow = data.daily.find((d) => d.day === today);
  const sum = (days: number) => {
    const cutoff = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    return data.daily.filter((d) => d.day >= cutoff).reduce((s, d) => s + d.messages, 0);
  };
  const todayCount = todayRow?.messages ?? 0;
  const writeRatio = (todayCount * WRITES_PER_MESSAGE) / data.limits.d1RowsWrittenPerDay;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await put('/admin/settings', settings);
      toast('已保存，每小时自动执行一次清理');
      qc.invalidateQueries({ queryKey: ['admin', 'usage'] });
    } catch (err) {
      error(err);
    } finally {
      setSaving(false);
    }
  };

  const cleanNow = async () => {
    setCleaning(true);
    try {
      await post('/admin/cleanup');
      toast('清理完成');
      qc.invalidateQueries({ queryKey: ['admin', 'usage'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['mailboxes'] });
    } catch (err) {
      error(err);
    } finally {
      setCleaning(false);
    }
  };

  const days = (key: keyof UsageReport['settings'], label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <div className="w-28">
          <Input type="number" min={0} max={3650} value={settings[key]} onChange={(e) => setSettings({ ...settings, [key]: Number(e.target.value) })} />
        </div>
        <span className="text-sm text-zinc-500">天</span>
      </div>
    </Field>
  );

  return (
    <PageShell title="用量与清理">
      <PageHeader title="用量与清理" description="Cloudflare 免费版的存储额度，以及邮件的自动清理设置。" />

      <div className="grid gap-4 md:grid-cols-2">
        <Meter label="D1 数据库" used={data.usage.d1Bytes} limit={data.limits.d1Bytes} hint="免费版单库上限 500 MB，存索引和搜索数据" />
        <Meter label="R2 存储（估算）" used={data.usage.r2Bytes} limit={data.limits.r2Bytes} hint="免费 10 GB，存原文、正文和附件" />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="邮件总数" value={compact(data.usage.messages)} />
        <Stat label="今日收信" value={compact(todayCount)} sub={`约 ${compact(todayCount * WRITES_PER_MESSAGE)} 行 D1 写入，额度的 ${(writeRatio * 100).toFixed(1)}%`} />
        <Stat label="近 7 天" value={compact(sum(7))} />
        <Stat label="近 30 天" value={compact(sum(30))} />
      </div>

      <Card className="mt-8 p-5">
        <h2 className="text-sm font-semibold">自动清理</h2>
        <p className="mt-1 mb-4 text-[13px] text-zinc-500">每小时执行一次。填 0 表示不自动删除。存储超过额度的 90% 时，会自动清空回收站和垃圾邮件。</p>
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            {days('trash_retention_days', '回收站保留', '超过后彻底删除')}
            {days('spam_retention_days', '垃圾邮件保留', '超过后彻底删除')}
            {days('mail_retention_days', '邮件保留', '收件箱和归档中的旧邮件，星标邮件不删')}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={saving}>
              保存设置
            </Button>
            <Button onClick={cleanNow} loading={cleaning}>
              立即清理一次
            </Button>
          </div>
        </form>
      </Card>

      <Card className="mt-4 p-5 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">为不超出免费额度已做的处理</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>页面静态资源直接由 Cloudflare 提供，不消耗 Worker 请求（免费 10 万次/天）。</li>
          <li>实时刷新使用 WebSocket 推送，连接空闲时休眠不计时长；断线后才改为每分钟轮询一次。</li>
          <li>收信时先存原文再解析，单次 10ms 的 CPU 限制不会造成退信；大邮件解析失败时可下载原文查看。</li>
          <li>全文索引只收录正文前 4000 字，控制 D1 体积（单库 500 MB）。</li>
          <li>清理和统计都走索引，没有可删除的邮件时几乎不读取数据行（免费 500 万行/天）。</li>
          <li>同一封邮件只推送一次 Bark，垃圾邮件不推送。</li>
        </ul>
      </Card>
    </PageShell>
  );
}
