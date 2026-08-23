'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { Hourglass } from 'lucide-react';

export function useRequireAuth(): boolean {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (loading) {
    return false;
  }
  return Boolean(user);
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const ready = useRequireAuth();
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-3 text-ink-soft">
          <Hourglass className="h-8 w-8 animate-spin text-accent [animation-duration:2.5s]" />
          <p className="text-sm">Loading DueKeeper…</p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
