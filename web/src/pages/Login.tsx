import { useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { post } from '../api';
import { Button, Field, Input } from '../components/ui';

function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
            <Mail className="size-5" strokeWidth={2.2} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-sm text-zinc-500">{subtitle}</p>
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">{children}</div>
      </div>
    </div>
  );
}

function useSubmit(fn: () => Promise<unknown>) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['auth'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };
  return { error, loading, onSubmit };
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { error, loading, onSubmit } = useSubmit(() => post('/auth/login', { email, password }));

  return (
    <AuthCard title="登录邮件中心" subtitle="使用管理员分配的账号登录">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="登录名">
          <Input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="密码">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <Button type="submit" variant="primary" loading={loading} className="w-full">
          登录
        </Button>
      </form>
    </AuthCard>
  );
}

export function SetupPage() {
  const [form, setForm] = useState({ token: '', name: '', email: '', password: '', confirm: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const { error, loading, onSubmit } = useSubmit(async () => {
    if (form.password !== form.confirm) throw new Error('两次输入的密码不一致');
    await post('/auth/setup', form);
  });

  return (
    <AuthCard title="初始化邮件中心" subtitle="创建第一个管理员账号">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="初始化码" hint="部署时生成的一次性代码">
          <Input required autoFocus autoComplete="off" value={form.token} onChange={set('token')} />
        </Field>
        <Field label="姓名">
          <Input autoComplete="name" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="登录名（邮箱格式）">
          <Input type="email" autoComplete="username" required value={form.email} onChange={set('email')} />
        </Field>
        <Field label="密码" hint="至少 8 位">
          <Input type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={set('password')} />
        </Field>
        <Field label="确认密码">
          <Input type="password" autoComplete="new-password" required value={form.confirm} onChange={set('confirm')} />
        </Field>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <Button type="submit" variant="primary" loading={loading} className="w-full">
          创建并登录
        </Button>
      </form>
    </AuthCard>
  );
}
