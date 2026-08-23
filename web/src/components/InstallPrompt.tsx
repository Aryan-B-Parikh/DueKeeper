'use client';

import { useEffect, useState } from 'react';
import { Download, Share, PlusSquare, X } from 'lucide-react';

const DISMISS_KEY = 'duekeeper.installDismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [platform, setPlatform] = useState<'none' | 'ios' | 'other'>('none');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) return;
    if (window.localStorage.getItem(DISMISS_KEY) === '1') return;

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setPlatform('other');
    };

    const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
    if (isIos) {
      setPlatform('ios');
      const timer = setTimeout(() => {}, 0);
      clearTimeout(timer);
    } else {
      window.addEventListener('beforeinstallprompt', onPrompt);
    }

    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  useEffect(() => {
    if ((platform === 'ios' || deferred) && platform !== 'none') setVisible(true);
  }, [platform, deferred]);

  function dismiss() {
    window.localStorage.setItem(DISMISS_KEY, '1');
    setVisible(false);
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === 'accepted') dismiss();
    else setVisible(false);
  }

  if (!visible || platform === 'none') return null;

  return (
    <div className="fixed inset-x-3 bottom-24 z-40 animate-fade-up sm:left-auto sm:right-4 sm:w-96 lg:bottom-4">
      <div className="neu-card p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold">
            {deferred ? 'Install DueKeeper' : 'Add DueKeeper to your Home Screen'}
          </p>
          <button
            onClick={dismiss}
            aria-label="Dismiss install suggestion"
            className="-mr-1 -mt-1 rounded-lg p-1 text-ink-soft transition hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {deferred ? (
          <>
            <p className="mt-1 text-xs text-ink-soft">
              Full-screen app with push reminders that reach you even when closed.
            </p>
            <div className="mt-3 flex gap-2">
              <button onClick={install} className="btn-primary flex-1 !py-2 text-xs">
                <Download className="h-3.5 w-3.5" /> Install app
              </button>
              <button onClick={dismiss} className="btn-ghost !py-2 text-xs">
                Later
              </button>
            </div>
          </>
        ) : (
          <ol className="mt-2 space-y-1.5 pl-0 text-xs leading-relaxed text-ink-soft [&>li]:flex [&>li]:items-center [&>li]:gap-2">
            <li>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-accent"><Share className="h-3.5 w-3.5" /></span>
              Tap the Share button in Safari
            </li>
            <li>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-accent"><PlusSquare className="h-3.5 w-3.5" /></span>
              Choose &quot;Add to Home Screen&quot;, then Add
            </li>
          </ol>
        )}
      </div>
    </div>
  );
}
