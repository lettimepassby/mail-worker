import { useState } from 'react';
import { post } from '../api';
import { useFeedback } from '../components/feedback';
import { Button, Card, Field, Input, PageHeader } from '../components/ui';
import { useSession } from '../lib/session';
import PageShell from './PageShell';

export default function SettingsPage() {
  const user = useSession();
  const { toast, error } = useFeedback();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.next !== form.confirm) return error(new Error('两次输入的新密码不一致'));
    setLoading(true);
    try {
      await post('/auth/password', { current: form.current, next: form.next });
      setForm({ current: '', next: '', confirm: '' });
      toast('密码已修改，其他设备已退出登录');
    } catch (err) {
      error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <PageShell title="账号设置">
      <PageHeader title="账号设置" description={`${user.name ? `${user.name} · ` : ''}${user.email} · ${user.role === 'admin' ? '管理员' : '成员'}`} />
      <Card className="max-w-md p-5">
        <h2 className="mb-4 text-sm font-semibold">修改密码</h2>
        <form onSubmit={submit} className="space-y-4">
          <Field label="当前密码">
            <Input type="password" autoComplete="current-password" required value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
          </Field>
          <Field label="新密码" hint="至少 8 位">
            <Input type="password" autoComplete="new-password" required minLength={8} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
          </Field>
          <Field label="确认新密码">
            <Input type="password" autoComplete="new-password" required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          </Field>
          <Button type="submit" variant="primary" loading={loading}>
            保存
          </Button>
        </form>
      </Card>
    </PageShell>
  );
}
