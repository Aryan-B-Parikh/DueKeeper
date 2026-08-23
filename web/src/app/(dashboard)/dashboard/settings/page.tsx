'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSearchParams } from 'next/navigation';
import { Copy, Download, RefreshCw, Link2, Link2Off, UserRound, Palette, Plug, KeyRound, AlertTriangle, BellRing } from 'lucide-react';
import { calendarApi, clearToken, userApi, type CalendarStatusResponse, type ProfileResponse } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ensurePushSubscription, unsubscribeBrowserPush } from '@/lib/push';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useToast } from '@/components/Toast';

const COMMON_TIMEZONES = [
  'UTC',
  'Asia/Kolkata',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney'
];

export default function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const { toast } = useToast();
  const params = useSearchParams();

  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<CalendarStatusResponse | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [reminderEmails, setReminderEmails] = useState(true);
  const [busy, setBusy] = useState(false);

  async function loadAll() {
    try {
      const [p, c] = await Promise.all([userApi.profile(), calendarApi.status()]);
      setProfile(p);
      setCalendarStatus(c);
      setDisplayName(p.user.displayName);
      setTimezone(p.user.timezone);
      setReminderEmails(p.user.notificationPrefs.reminderEmails !== false);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to load settings');
    }
  }

  useEffect(() => {
    void loadAll();
    void refreshUser();
    if (params.get('google') === 'connected') {
      toast('success', 'Google Calendar connected');
    } else if (params.get('google') === 'error') {
      toast('error', 'Google connection failed or expired â€” try again');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setBusy(true);
    try {
      await userApi.updateProfile({
        displayName,
        timezone,
        notificationPrefs: { reminderEmails }
      });
      await refreshUser();
      await loadAll();
      toast('success', 'Settings saved');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-ink-soft">Profile, appearance and integrations.</p>
      </div>

      <section className="neu-card p-6">
        <h2 className="flex items-center gap-2 font-semibold">
          <UserRound className="h-4 w-4 text-accent" /> Profile
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="set-name" className="label">
              Display name
            </label>
            <input
              id="set-name"
              value={displayName}
              maxLength={80}
              onChange={(e) => setDisplayName(e.target.value)}
              className="neu-input"
            />
          </div>
          <div>
            <label htmlFor="set-tz" className="label">
              Timezone
            </label>
            <input
              id="set-tz"
              list="tz-list"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="neu-input"
            />
            <datalist id="tz-list">
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </div>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={reminderEmails}
            onChange={(e) => setReminderEmails(e.target.checked)}
            className="h-4 w-4 accent-[rgb(var(--accent))]"
          />
          Also receive email reminders (requires SMTP on the server)
        </label>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-line/60 pt-5">
          <code className="truncate text-xs text-ink-soft">{user?.email}</code>
          <div className="flex shrink-0 gap-2">
            <RevokeSessionsButton />
            <button onClick={save} disabled={busy} className="btn-primary">
              Save changes
            </button>
          </div>
        </div>
      </section>

      <section className="neu-card flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <Palette className="h-4 w-4 text-accent" /> Appearance
          </h2>
          <p className="mt-1 text-sm text-ink-soft">Light, dark, or follow your system.</p>
        </div>
        <ThemeToggle />
      </section>

      <section className="neu-card p-6">
        <h2 className="flex items-center gap-2 font-semibold">
          <BellRing className="h-4 w-4 text-accent" /> Browser push
        </h2>
        <PushSection />
      </section>

      <section className="neu-card p-6">
        <h2 className="flex items-center gap-2 font-semibold">
          <Plug className="h-4 w-4 text-accent" /> Google Calendar
        </h2>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink-soft">
            {!calendarStatus
              ? 'Checking statusâ€¦'
              : !calendarStatus.googleConfigured
                ? 'Not configured on this server (GOOGLE_CLIENT_ID / SECRET missing). ICS import & export work without it.'
                : calendarStatus.connected
                  ? `Connected. Last synced: ${calendarStatus.lastSyncedAt ? new Date(calendarStatus.lastSyncedAt).toLocaleString() : 'never'}`
                  : 'Connect to one-way sync deadline-worthy events from your primary calendar.'}
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            {calendarStatus?.connected && (
              <>
                <SyncButton onDone={() => void loadAll()} />
                <DisconnectButton onDone={() => void loadAll()} />
              </>
            )}
            {!calendarStatus?.connected && calendarStatus?.googleConfigured && (
              <a href={calendarApi.googleStartUrl()} className="btn-primary">
                <Link2 className="h-4 w-4" /> Connect Google
              </a>
            )}
          </div>
        </div>
      </section>

      <section className="neu-card p-6">
        <h2 className="flex items-center gap-2 font-semibold">
          <KeyRound className="h-4 w-4 text-accent" /> Password
        </h2>
        <PasswordForm />
      </section>

      <section className="neu-card p-6">
        <h2 className="flex items-center gap-2 font-semibold">
          <Download className="h-4 w-4 text-accent" /> Your data
        </h2>
        <p className="mt-1 text-sm text-ink-soft">Download everything DueKeeper stores about you.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href={`${calendarApi.exportUrl()}`} download="duekeeper.ics" className="btn-ghost">
            <Download className="h-4 w-4" /> Export deadlines (.ics)
          </a>
          <ExportJsonButton />
        </div>
      </section>

      <section className="neu-card border-danger/40 p-6">
        <h2 className="flex items-center gap-2 font-semibold text-danger">
          <AlertTriangle className="h-4 w-4" /> Danger zone
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Permanently delete your account, every deadline, reminder and notification. There is no undo.
        </p>
        <DeleteAccountButton />
      </section>

      <section className="neu-card p-6">
        <h2 className="flex items-center gap-2 font-semibold">
          <Copy className="h-4 w-4 text-accent" /> Forwarding address
        </h2>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 truncate rounded-xl bg-surface px-4 py-2.5 font-mono text-sm shadow-neu-inset">
            {profile?.forwardingAddress ?? 'â€¦'}
          </code>
          <button
            className="btn-ghost shrink-0"
            onClick={async () => {
              if (!profile) return;
              await navigator.clipboard.writeText(profile.forwardingAddress);
              toast('success', 'Address copied');
            }}
          >
            <Copy className="h-4 w-4" /> Copy
          </button>
        </div>
      </section>
    </div>
  );
}

function RevokeSessionsButton() {
  const { signOut } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  return (
    <button
      className="btn-ghost"
      disabled={busy}
      title="Invalidate every signed-in session, including this one"
      onClick={async () => {
        setBusy(true);
        try {
          await userApi.revokeAllSessions();
          clearToken();
          signOut();
          router.replace('/login');
          toast('info', 'All sessions revoked â€” sign in again');
        } catch (err) {
          toast('error', err instanceof Error ? err.message : 'Failed to revoke sessions');
        } finally {
          setBusy(false);
        }
      }}
    >
      <Link2Off className="h-4 w-4" /> Sign out everywhere
    </button>
  );
}

function PushSection() {
  const { toast } = useToast();
  const [state, setState] = useState<'loading' | 'unavailable' | 'off' | 'on'>('loading');
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const status = await userApi.pushStatus();
      setDevices(status.subscribedDevices);
      setState(status.available ? (status.subscribedDevices > 0 ? 'on' : 'off') : 'unavailable');
    } catch {
      setState('unavailable');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function enable() {
    setBusy(true);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        toast('error', 'This browser does not support web push');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast('info', 'Permission denied â€” enable notifications for this site to continue');
        return;
      }
      const { publicKey } = await userApi.pushPublicKey();
      if (!publicKey) throw new Error('Push is not configured on the server');
      const dto = await ensurePushSubscription(publicKey);
      await userApi.pushSubscribe(dto);
      toast('success', 'Push reminders enabled on this device');
      await refresh();
      setState('on');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not enable push');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const endpoint = await unsubscribeBrowserPush();
      if (endpoint) await userApi.pushUnsubscribe(endpoint);
      toast('info', 'Push disabled on this device');
      await refresh();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not disable push');
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    try {
      const result = await userApi.pushTest();
      if (result.sent > 0) toast('success', `Test push delivered to ${result.sent} device(s)`);
      else toast('info', 'Sent, but no device confirmed receipt â€” try re-enabling push');
      await refresh();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Test failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-ink-soft">
        {state === 'loading' && 'Checking supportâ€¦'}
        {state === 'unavailable' && 'Not available here (needs HTTPS or a supported browser).'}
        {state === 'off' && 'Off. Enable to get reminders even when DueKeeper is closed.'}
        {state === 'on' && `Enabled on ${devices} device(s), including this browser.`}
      </p>
      <div className="flex shrink-0 flex-wrap gap-2">
        {state === 'on' && (
          <>
            <button onClick={sendTest} disabled={busy} className="btn-primary">
              Send test push
            </button>
            <button onClick={disable} disabled={busy} className="btn-ghost">
              Disable here
            </button>
          </>
        )}
        {state === 'off' && (
          <button onClick={enable} disabled={busy} className="btn-primary">
            <BellRing className="h-4 w-4" /> Enable push reminders
          </button>
        )}
      </div>
    </div>
  );
}

function PasswordForm() {
  const { toast } = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="mt-4 grid gap-4 sm:grid-cols-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (next !== confirmPw) {
          toast('error', 'New passwords do not match');
          return;
        }
        setBusy(true);
        try {
          await userApi.changePassword({ currentPassword: current, newPassword: next });
          toast('success', 'Password updated');
          setCurrent('');
          setNext('');
          setConfirmPw('');
        } catch (err) {
          toast('error', err instanceof Error ? err.message : 'Could not change password');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <label htmlFor="pw-current" className="label">Current</label>
        <input
          id="pw-current"
          type="password"
          required
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="neu-input"
        />
      </div>
      <div>
        <label htmlFor="pw-new" className="label">New</label>
        <input
          id="pw-new"
          type="password"
          required
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="neu-input"
        />
      </div>
      <div>
        <label htmlFor="pw-confirm" className="label">Confirm new</label>
        <input
          id="pw-confirm"
          type="password"
          required
          autoComplete="new-password"
          value={confirmPw}
          onChange={(e) => setConfirmPw(e.target.value)}
          className="neu-input"
        />
      </div>
      <div className="sm:col-span-3">
        <button type="submit" disabled={busy} className="btn-primary">
          Update password
        </button>
      </div>
    </form>
  );
}

function ExportJsonButton() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn-ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await userApi.downloadExport();
          toast('success', 'Export downloaded');
        } catch (err) {
          toast('error', err instanceof Error ? err.message : 'Export failed');
        } finally {
          setBusy(false);
        }
      }}
    >
      <Copy className="h-4 w-4" /> Export everything (.json)
    </button>
  );
}

function DeleteAccountButton() {
  const { signOut } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="mt-4 space-y-3">
      <input
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder='Type "DELETE" to confirm'
        className="neu-input max-w-xs border-danger/40"
      />
      <button
        disabled={busy || confirmText !== 'DELETE'}
        onClick={async () => {
          setBusy(true);
          try {
            await userApi.deleteAccount();
            clearToken();
            signOut();
            router.replace('/');
            toast('info', 'Account deleted. Goodbye.');
          } catch (err) {
            toast('error', err instanceof Error ? err.message : 'Deletion failed');
          } finally {
            setBusy(false);
          }
        }}
        className="btn-danger"
      >
        Delete my account forever
      </button>
    </div>
  );
}

function SyncButton({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn-primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const result = await calendarApi.syncGoogle();
          toast('success', `Synced: ${result.imported} new, ${result.updated} updated`);
          onDone();
        } catch (err) {
          toast('error', err instanceof Error ? err.message : 'Sync failed');
        } finally {
          setBusy(false);
        }
      }}
    >
      <RefreshCw className={busy ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /> Sync now
    </button>
  );
}

function DisconnectButton({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  return (
    <button
      className="btn-ghost"
      onClick={async () => {
        try {
          await calendarApi.disconnectGoogle();
          toast('info', 'Google disconnected');
          onDone();
        } catch (err) {
          toast('error', err instanceof Error ? err.message : 'Disconnect failed');
        }
      }}
    >
      <Link2Off className="h-4 w-4" /> Disconnect
    </button>
  );
}
