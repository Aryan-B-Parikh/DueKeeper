'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sparkles, BellRing, CalendarDays, ShieldCheck, ArrowRight } from 'lucide-react';
import { getToken } from '@/lib/api';
import { Logo } from '@/components/Logo';

const FEATURES = [
  {
    icon: Sparkles,
    title: 'AI deadline extraction',
    body: 'Paste messy text or drop a screenshot — DueKeeper pulls out dates, times and types. Works even without an AI key thanks to a built-in parser.'
  },
  {
    icon: BellRing,
    title: 'Reminders that actually arrive',
    body: 'A transactional outbox engine with retries and leases, live in-app alerts, email and web push — even when the tab is closed.'
  },
  {
    icon: CalendarDays,
    title: 'Plays well with calendars',
    body: 'Import .ics from Google, Outlook or Apple with duplicate protection. Export everything back out anytime.'
  },
  {
    icon: ShieldCheck,
    title: 'Yours, privately',
    body: 'Your own account, your own database file, timezone-correct deadlines and one-click export or deletion of every byte we store.'
  }
];

export default function LandingPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (getToken()) {
      router.replace('/dashboard');
    } else {
      setChecking(false);
    }
  }, [router]);

  if (checking) {
    return <div className="min-h-screen bg-surface" />;
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-surface">
      <div
        className="pointer-events-none absolute -right-40 -top-40 h-96 w-96 rounded-full opacity-25 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgb(var(--accent)), transparent 70%)' }}
      />
      <div
        className="pointer-events-none absolute -bottom-48 -left-32 h-96 w-96 rounded-full opacity-20 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgb(var(--accent)), transparent 70%)' }}
      />

      <div className="relative mx-auto max-w-5xl px-6 py-16 sm:py-24">
        <header className="flex items-center justify-between">
          <Logo />
          <nav className="flex items-center gap-3">
            <Link href="/login" className="btn-ghost">
              Sign in
            </Link>
            <Link href="/register" className="btn-primary">
              Get started
            </Link>
          </nav>
        </header>

        <section className="mt-20 max-w-2xl animate-fade-up">
          <span className="chip bg-accent-soft text-accent">Free · self-contained · no lock-in</span>
          <h1 className="mt-4 text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
            Never miss what&apos;s <span className="text-accent">due</span> again.
          </h1>
          <p className="mt-4 text-lg text-ink-soft">
            DueKeeper tracks exams, submissions and hackathons — extracting deadlines from screenshots and pasted
            text, then making sure a reminder actually reaches you.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/register" className="btn-primary px-6 py-3 text-base">
              Create free account <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/login" className="btn-ghost px-6 py-3 text-base">
              I already have one
            </Link>
          </div>
        </section>

        <section className="mt-16 grid gap-4 sm:grid-cols-2">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="neu-card p-6 transition hover:-translate-y-0.5">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent shadow-neu-sm">
                <Icon className="h-5 w-5" />
              </span>
              <h2 className="mt-4 font-semibold">{title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{body}</p>
            </div>
          ))}
        </section>

        <footer className="mt-16 flex flex-wrap items-center justify-between gap-3 border-t border-line/60 pt-6 text-xs text-ink-soft">
          <span>© {new Date().getFullYear()} DueKeeper — MIT licensed.</span>
          <span>Next.js · Express · SQLite · Web Push</span>
        </footer>
      </div>
    </main>
  );
}
