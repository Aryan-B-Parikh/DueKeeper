'use client';

import { useState, useEffect } from 'react';
import { Sparkles, Clock, Bell, Check } from 'lucide-react';
import { browserTimezone } from '@/lib/utils';

interface OnboardingProps {
  onComplete: (prefs: { timezone: string; reminderEmails: boolean; dueSoonAlerts: boolean }) => void;
  onSkip: () => void;
}

export function Onboarding({ onComplete, onSkip }: OnboardingProps) {
  const [step, setStep] = useState(1);
  const [timezone, setTimezone] = useState('UTC');
  const [reminderEmails, setReminderEmails] = useState(true);
  const [dueSoonAlerts, setDueSoonAlerts] = useState(true);

  useEffect(() => {
    try { setTimezone(browserTimezone()); } catch {}
  }, []);

  return (
    <div className="neu-card max-w-lg mx-auto p-6 space-y-6 animate-fade-up">
      <div className="flex items-center gap-2 text-sm text-ink-soft">
        <span className={`h-2 w-8 rounded-full ${step>=1?'bg-accent':'bg-line'}`} />
        <span className={`h-2 w-8 rounded-full ${step>=2?'bg-accent':'bg-line'}`} />
        <span className={`h-2 w-8 rounded-full ${step>=3?'bg-accent':'bg-line'}`} />
        <span className="ml-auto">{step}/3</span>
      </div>

      {step === 1 && (
        <div className="space-y-4 text-center">
          <Sparkles className="mx-auto h-10 w-10 text-accent" />
          <h2 className="text-xl font-bold">Welcome to DueKeeper</h2>
          <p className="text-sm text-ink-soft">Never miss what’s due. Let’s set up your workspace in 30 seconds.</p>
          <button onClick={() => setStep(2)} className="btn-primary w-full">Get started</button>
          <button onClick={onSkip} className="btn-ghost w-full text-xs">Skip</button>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-accent" />
            <h2 className="font-semibold">Your timezone</h2>
          </div>
          <p className="text-sm text-ink-soft">We detected <strong>{timezone}</strong>. Correct?</p>
          <input value={timezone} onChange={e => setTimezone(e.target.value)} className="neu-input" placeholder="Asia/Kolkata" />
          <p className="text-xs text-ink-soft">IANA identifier — keeps “Friday 5pm” meaning Friday 5pm where you live, even when you travel.</p>
          <div className="flex gap-2">
            <button onClick={() => setStep(1)} className="btn-ghost flex-1">Back</button>
            <button onClick={() => setStep(3)} className="btn-primary flex-1">Next</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-accent" />
            <h2 className="font-semibold">Notifications</h2>
          </div>
          <label className="flex items-center justify-between gap-3 neu-card p-3">
            <span className="text-sm">Email reminders</span>
            <input type="checkbox" checked={reminderEmails} onChange={e => setReminderEmails(e.target.checked)} className="h-4 w-4" />
          </label>
          <label className="flex items-center justify-between gap-3 neu-card p-3">
            <span className="text-sm">Due-soon alerts (72h)</span>
            <input type="checkbox" checked={dueSoonAlerts} onChange={e => setDueSoonAlerts(e.target.checked)} className="h-4 w-4" />
          </label>
          <button onClick={() => onComplete({ timezone, reminderEmails, dueSoonAlerts })} className="btn-primary w-full">
            <Check className="h-4 w-4" /> Complete & add first deadline
          </button>
          <button onClick={() => setStep(2)} className="btn-ghost w-full text-xs">Back</button>
        </div>
      )}
    </div>
  );
}
