import { Menu } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from '../components/ui';
import { useNav } from '../lib/session';

/** Scrollable page frame for non-mail pages, with the mobile menu button. */
export default function PageShell({ title, children }: { title: string; children: ReactNode }) {
  const { openNav } = useNav();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-2 pt-[env(safe-area-inset-top)] box-content lg:hidden dark:border-zinc-800 dark:bg-zinc-900">
        <IconButton label="菜单" onClick={openNav}>
          <Menu className="size-5" />
        </IconButton>
        <span className="font-semibold">{title}</span>
      </div>
      <div className="pane-scroll flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 lg:py-8">{children}</div>
      </div>
    </div>
  );
}
