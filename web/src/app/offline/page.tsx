import { WifiOff } from 'lucide-react';
import Link from 'next/link';

export const metadata = { title: 'Offline — DueKeeper' };

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface p-6 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-warn/15 text-warn shadow-neu-sm">
        <WifiOff className="h-8 w-8" />
      </span>
      <h1 className="text-2xl font-bold">You&apos;re offline</h1>
      <p className="max-w-sm text-sm text-ink-soft">
        DueKeeper needs a connection to sync deadlines and deliver reminders. Cached pages are still available —
        reconnect and try again.
      </p>
      <Link href="/dashboard" className="btn-primary mt-2">
        Try dashboard
      </Link>
    </main>
  );
}
