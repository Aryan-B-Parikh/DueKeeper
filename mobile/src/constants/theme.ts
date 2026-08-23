export const theme = {
  accent: '#6d54eb',
  accentStrong: '#583ed6',
  accentSoft: 'rgba(109, 84, 235, 0.12)',
  surface: '#f5f4fc',
  surfaceRaised: '#ffffff',
  ink: '#26223f',
  inkSoft: '#6e698c',
  line: 'rgba(110, 105, 140, 0.18)',
  danger: '#e2485c',
  warn: '#d98a1e',
  success: '#2ea06e',
  white: '#ffffff'
} as const;

export const statusColors: Record<string, { bg: string; text: string; label: string }> = {
  upcoming: { bg: 'rgba(109,84,235,0.14)', text: '#6d54eb', label: 'Upcoming' },
  due_soon: { bg: 'rgba(217,138,30,0.16)', text: '#b06f12', label: 'Due soon' },
  overdue: { bg: 'rgba(226,72,92,0.15)', text: '#e2485c', label: 'Overdue' },
  done: { bg: 'rgba(46,160,110,0.15)', text: '#2ea06e', label: 'Done' },
  cancelled: { bg: 'rgba(110,105,140,0.15)', text: '#6e698c', label: 'Cancelled' }
};
