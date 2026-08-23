import { GraduationCap, FileText, Trophy, CalendarClock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const typeIcons: Record<string, LucideIcon> = {
  exam: GraduationCap,
  submission: FileText,
  hackathon: Trophy,
  other: CalendarClock
};

export const statusStyles: Record<string, string> = {
  upcoming: 'bg-accent-soft text-accent',
  due_soon: 'bg-warn/15 text-warn',
  overdue: 'bg-danger/15 text-danger',
  done: 'bg-success/15 text-success',
  cancelled: 'bg-ink-soft/15 text-ink-soft'
};

export const statusLabels: Record<string, string> = {
  upcoming: 'Upcoming',
  due_soon: 'Due soon',
  overdue: 'Overdue',
  done: 'Done',
  cancelled: 'Cancelled'
};
