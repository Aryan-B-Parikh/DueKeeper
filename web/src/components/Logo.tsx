import { Hourglass } from 'lucide-react';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        className="flex h-10 w-10 items-center justify-center rounded-xl text-white"
        style={{
          backgroundImage: 'linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-strong)))',
          boxShadow: '0 8px 18px rgb(var(--accent) / 0.4)'
        }}
      >
        <Hourglass className="h-5 w-5" />
      </span>
      {!compact && (
        <span className="text-xl font-bold tracking-tight">
          Due<span className="text-accent">Keeper</span>
        </span>
      )}
    </span>
  );
}
