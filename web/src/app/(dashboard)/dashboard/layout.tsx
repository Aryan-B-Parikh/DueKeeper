'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  CalendarDays,
  Inbox,
  Settings,
  Plus,
  LogOut,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { AuthGate } from '@/hooks/useRequireAuth';
import { NotificationBell } from '@/components/NotificationBell';
import { InstallPrompt } from '@/components/InstallPrompt';
import { Logo } from '@/components/Logo';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/dashboard/inbox', label: 'Inbox', icon: Inbox },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings }
];

function SidebarContent() {
  const pathname = usePathname();
  const { user, signOut } = useAuth();

  return (
    <div className="flex h-full flex-col gap-6 p-5">
      <Link href="/dashboard" className="px-1">
        <Logo />
      </Link>

      <nav className="flex flex-1 flex-col gap-1.5">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium transition',
                active
                  ? 'bg-accent-soft text-accent shadow-neu-inset'
                  : 'text-ink-soft hover:bg-surface hover:text-ink shadow-neu-sm'
              )}
            >
              <Icon className="h-4.5 w-4.5 h-[18px] w-[18px]" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-3">
        <Link
          href="/dashboard/events/new"
          className="btn-primary w-full"
        >
          <Plus className="h-4 w-4" /> Add deadline
        </Link>
        <div className="neu-flat flex items-center justify-between gap-2 p-3">
          <span className="truncate text-sm font-medium">{user?.displayName ?? user?.email}</span>
          <button
            onClick={signOut}
            title="Sign out"
            aria-label="Sign out"
            className="rounded-lg p-2 text-ink-soft transition hover:bg-danger/10 hover:text-danger"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <div className="min-h-screen bg-surface">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line/60 bg-surface lg:block">
          <SidebarContent />
        </aside>

        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line/60 bg-surface/95 px-4 py-3 backdrop-blur lg:hidden">
          <Logo compact />
          <div className="flex items-center gap-3">
            <NotificationBell />
            <SignOutMobile />
          </div>
        </header>

        <main className="pb-24 pt-6 lg:pb-10 lg:pl-64 lg:pr-8 lg:pt-8">
          <div className="mx-auto max-w-4xl px-4 sm:px-0">{children}</div>
        </main>

        <nav
          className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-line/60 bg-surface/95 py-1.5 backdrop-blur lg:hidden"
          style={{ paddingBottom: 'max(0.375rem, env(safe-area-inset-bottom))' }}
        >
          {NAV.map(({ href, label, icon: Icon }) => (
            <NavItem key={href} href={href} label={label}>
              <Icon className="h-5 w-5" />
            </NavItem>
          ))}
        </nav>
        <InstallPrompt />
      </div>
    </AuthGate>
  );
}

function NavItem({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={cn(
        'flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1 text-[11px] font-medium transition',
        active ? 'text-accent' : 'text-ink-soft'
      )}
    >
      {children}
      {label}
    </Link>
  );
}

function SignOutMobile() {
  const { signOut } = useAuth();
  return (
    <button
      onClick={signOut}
      aria-label="Sign out"
      className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface text-ink-soft shadow-neu-sm transition hover:text-danger"
    >
      <LogOut className="h-5 w-5" />
    </button>
  );
}
