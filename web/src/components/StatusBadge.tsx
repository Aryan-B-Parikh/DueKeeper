import { cn } from '@/lib/utils';
import { statusStyles, statusLabels } from '@/lib/meta';

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn('chip', statusStyles[status] ?? statusStyles.upcoming, className)}>
      {statusLabels[status] ?? status}
    </span>
  );
}
