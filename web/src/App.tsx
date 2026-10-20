import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { api, type AuthState } from './api';
import AppLayout from './components/AppLayout';
import { Spinner } from './components/ui';
import { SessionContext, useSession } from './lib/session';
import DomainsPage from './pages/admin/Domains';
import NotifyPage from './pages/admin/Notify';
import RulesPage from './pages/admin/Rules';
import UsagePage from './pages/admin/Usage';
import UsersPage from './pages/admin/Users';
import { LoginPage, SetupPage } from './pages/Login';
import MailPage from './pages/Mail';
import SettingsPage from './pages/Settings';

function AdminOnly({ children }: { children: ReactNode }) {
  const user = useSession();
  return user.role === 'admin' ? children : <Navigate to="/mail/inbox" replace />;
}

export default function App() {
  const { data, isPending, error } = useQuery({
    queryKey: ['auth'],
    queryFn: () => api<AuthState>('/auth/state'),
    staleTime: Infinity,
  });

  if (isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-red-600">无法连接服务器：{error.message}</div>;
  }
  if (data.needsSetup) return <SetupPage />;
  if (!data.user) return <LoginPage />;

  return (
    <SessionContext.Provider value={data.user}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to="/mail/inbox" replace />} />
          <Route path="mail/:view" element={<MailPage />} />
          <Route path="mail/:view/:id" element={<MailPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route
            path="admin/users"
            element={
              <AdminOnly>
                <UsersPage />
              </AdminOnly>
            }
          />
          <Route
            path="admin/domains"
            element={
              <AdminOnly>
                <DomainsPage />
              </AdminOnly>
            }
          />
          <Route
            path="admin/rules"
            element={
              <AdminOnly>
                <RulesPage />
              </AdminOnly>
            }
          />
          <Route
            path="admin/notify"
            element={
              <AdminOnly>
                <NotifyPage />
              </AdminOnly>
            }
          />
          <Route
            path="admin/usage"
            element={
              <AdminOnly>
                <UsagePage />
              </AdminOnly>
            }
          />
          <Route path="*" element={<Navigate to="/mail/inbox" replace />} />
        </Route>
      </Routes>
    </SessionContext.Provider>
  );
}
