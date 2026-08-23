'use client';

import { useEffect, useState } from 'react';
import { Copy, Inbox, Mail, ShieldCheck, AlertTriangle } from 'lucide-react';
import { userApi } from '@/lib/api';
import { useToast } from '@/components/Toast';

export default function InboxPage() {
  const [address, setAddress] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    let alive = true;
    userApi
      .profile()
      .then((profile) => {
        if (!alive) return;
        setAddress(profile.forwardingAddress);
        setConfigured(profile.inboxConfigured);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Email inbox</h1>
        <p className="text-sm text-ink-soft">Turn forwarded emails into deadlines automatically.</p>
      </div>

      <div className="neu-card p-6">
        <p className="flex items-center gap-2 font-semibold">
          <Inbox className="h-4 w-4 text-accent" /> Your personal forwarding address
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 truncate rounded-xl bg-surface px-4 py-2.5 font-mono text-sm shadow-neu-inset">
            {address ?? 'Loading…'}
          </code>
          <button
            className="btn-ghost shrink-0"
            disabled={!address}
            onClick={async () => {
              if (!address) return;
              await navigator.clipboard.writeText(address);
              toast('success', 'Address copied');
            }}
          >
            <Copy className="h-4 w-4" /> Copy
          </button>
        </div>

        {!configured && (
          <p className="mt-4 flex items-start gap-2 rounded-xl bg-warn/10 px-4 py-3 text-xs text-warn">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            The inbox webhook is not configured on this server (INBOX_WEBHOOK_TOKEN missing). Emails sent to the
            address above will only be processed once inbound parsing is enabled — see docs/SETUP.md.
          </p>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Step number={1} title="Forward any email">
          Send or forward a message containing deadline details to your unique address — e.g. an LMS notification or
          exam schedule mail.
        </Step>
        <Step number={2} title="We extract the dates">
          The parser scans subject and body, finds due dates with confidence scores and auto-saves anything it is at
          least 70% sure about.
        </Step>
        <Step number={3} title="You get notified">
          A confirmation lands in your notifications, plus an email receipt so you always know what was captured.
        </Step>
      </div>

      <div className="neu-card flex items-start gap-3 p-5">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" />
        <div className="text-sm text-ink-soft">
          <strong className="text-ink">Private by design.</strong> Your address contains a random token that maps only
          to your account. Inbound requests are authenticated with a shared webhook secret using constant-time
          comparison, and unknown senders are ignored.
        </div>
      </div>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div className="neu-flat p-5">
      <span className="chip bg-accent-soft text-accent">Step {number}</span>
      <p className="mt-3 font-semibold">{title}</p>
      <p className="mt-1 text-sm text-ink-soft">{children}</p>
    </div>
  );
}
