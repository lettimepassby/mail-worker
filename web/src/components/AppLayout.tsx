import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { NavContext } from '../lib/session';
import Sidebar from './Sidebar';
import { cx } from './ui';

export default function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname, location.search]);

  return (
    <NavContext.Provider value={{ openNav: () => setNavOpen(true) }}>
      <div className="flex h-dvh overflow-hidden">
        <aside className="hidden w-64 shrink-0 border-r border-zinc-200 bg-white lg:block dark:border-zinc-800 dark:bg-zinc-900">
          <Sidebar />
        </aside>

        <div className={cx('fixed inset-0 z-40 lg:hidden', navOpen ? '' : 'pointer-events-none')} aria-hidden={!navOpen}>
          <div
            className={cx('absolute inset-0 bg-zinc-950/40 transition-opacity', navOpen ? 'opacity-100' : 'opacity-0')}
            onClick={() => setNavOpen(false)}
          />
          <aside
            className={cx(
              'absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-xl transition-transform duration-200 dark:bg-zinc-900',
              navOpen ? 'translate-x-0' : '-translate-x-full',
            )}
          >
            <Sidebar />
          </aside>
        </div>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </NavContext.Provider>
  );
}
