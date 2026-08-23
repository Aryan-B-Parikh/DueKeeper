export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

import { getAccessToken as getToken, storeAuth, clearAuth, refreshAccessToken } from './tokenStore';
export { getToken };

import { getRefreshToken } from './tokenStore';

export function setAuth(accessToken: string, refreshToken: string): void {
  storeAuth(accessToken, refreshToken);
}

export function clearToken(): void {
  clearAuth();
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>)
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (res.status === 204) return undefined as T;

  if (res.status === 401 && retry && !path.startsWith('/api/auth/') && getRefreshToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return request<T>(path, options, false);
    }
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? `Request failed (${res.status})`);
  }
  return json as T;
}

async function upload<T>(path: string, form: FormData): Promise<T> {
  return request<T>(path, { method: 'POST', body: form });
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  timezone: string;
  notificationPrefs: Record<string, boolean>;
  createdAt: string;
}

export interface Reminder {
  id?: string;
  offsetSeconds: number;
  channel: 'email' | 'in_app';
  enabled: boolean;
}

export type EventType = 'exam' | 'submission' | 'hackathon' | 'other';
export type EventStatus = 'upcoming' | 'due_soon' | 'overdue' | 'done' | 'cancelled';

export interface EventItem {
  id: string;
  title: string;
  description: string | null;
  eventType: EventType;
  dueAt: string;
  timezone: string;
  source: string;
  aiConfidence: number | null;
  confirmationStatus: string | null;
  status: EventStatus;
  doneAt: string | null;
  reminders: Reminder[];
  createdAt: string;
  updatedAt: string;
}

export interface ExtractCandidate {
  id: string;
  title: string;
  eventType: EventType;
  dueAt: string | null;
  timezone: string;
  confidence: number;
  needsClarification: boolean;
}

export interface EventWriteInput {
  title?: string;
  description?: string | null;
  eventType?: EventType;
  dueAt?: string;
  timezone?: string;
  reminders?: Array<{ offsetSeconds: number; channel: 'email' | 'in_app' }>;
}

export interface AppNotification {
  id: string;
  eventId: string | null;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export interface ProfileResponse {
  user: PublicUser;
  forwardingAddress: string;
  inboxConfigured: boolean;
}

export interface CalendarStatusResponse {
  googleConfigured: boolean;
  connected: boolean;
  lastSyncedAt: string | null;
  importExportEnabled: boolean;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
}

export interface AuthPayload {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export const authApi = {
  async register(input: { email: string; password: string; displayName: string }) {
    return request<AuthPayload>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  },
  async login(input: { email: string; password: string }) {
    return request<AuthPayload>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  },
  me() {
    return request<{ user: PublicUser }>('/api/auth/me');
  },
  async logout() {
    const refreshToken = typeof window !== 'undefined' ? window.localStorage.getItem('duekeeper.refresh') : null;
    try {
      if (refreshToken) {
        await fetch(`${API_URL}/api/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken })
        });
      }
    } finally {
      clearToken();
    }
  }
};

export const eventsApi = {
  list(params: { status?: string } = {}) {
    return request<{ events: EventItem[] }>(`/api/events${qs(params)}`);
  },
  get(id: string) {
    return request<{ event: EventItem }>(`/api/events/${id}`);
  },
  create(body: EventWriteInput) {
    return request<{ event: EventItem }>('/api/events', { method: 'POST', body: JSON.stringify(body) });
  },
  update(id: string, body: EventWriteInput) {
    return request<{ event: EventItem }>(`/api/events/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  remove(id: string) {
    return request<void>(`/api/events/${id}`, { method: 'DELETE' });
  },
  markDone(id: string) {
    return request<{ event: EventItem }>(`/api/events/${id}/done`, { method: 'POST' });
  },
  cancel(id: string) {
    return request<{ event: EventItem }>(`/api/events/${id}/cancel`, { method: 'POST' });
  },
  snooze(id: string, duration: '1h' | '1d' | '1w') {
    return request<{ event: EventItem }>(`/api/events/${id}/snooze`, {
      method: 'POST',
      body: JSON.stringify({ duration })
    });
  }
};

export const extractApi = {
  fromText(text: string, timezone: string) {
    return request<{ engine: string; candidates: ExtractCandidate[] }>('/api/events/extract', {
      method: 'POST',
      body: JSON.stringify({ text, timezone })
    });
  },
  fromScreenshot(file: File, timezone: string) {
    const form = new FormData();
    form.append('screenshot', file);
    form.append('timezone', timezone);
    return upload<{ engine: string; candidates: ExtractCandidate[] }>('/api/events/extract', form);
  },
  confirm(
    events: Array<{
      title: string;
      eventType: EventType;
      dueAt: string;
      timezone: string;
      reminders?: Array<{ offsetSeconds: number; channel: 'email' | 'in_app' }>;
    }>,
    source: 'ai_text' | 'ai_screenshot'
  ) {
    return request<{ events: EventItem[] }>('/api/events/extract/confirm', {
      method: 'POST',
      body: JSON.stringify({ events, source })
    });
  }
};

export const notificationsApi = {
  list(params: { unreadOnly?: boolean; limit?: number } = {}) {
    return request<{ notifications: AppNotification[]; unreadCount: number }>(
      `/api/notifications${qs({ unreadOnly: params.unreadOnly, limit: params.limit })}`
    );
  },
  unreadCount() {
    return request<{ unreadCount: number }>('/api/notifications/unread-count');
  },
  markRead(id: string) {
    return request<{ ok: boolean }>(`/api/notifications/${id}/read`, { method: 'POST' });
  },
  markAllRead() {
    return request<{ ok: boolean }>('/api/notifications/read-all', { method: 'POST' });
  }
};

export const userApi = {
  profile() {
    return request<ProfileResponse>('/api/user/profile');
  },
  updateProfile(input: {
    displayName?: string;
    timezone?: string;
    notificationPrefs?: Record<string, boolean>;
  }) {
    return request<{ user: PublicUser }>('/api/user/profile', {
      method: 'PUT',
      body: JSON.stringify(input)
    });
  },
  async changePassword(input: { currentPassword: string; newPassword: string }) {
    return request<{ ok: boolean }>('/api/user/password', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  },
  async downloadExport(): Promise<void> {
    const token = getToken();
    const res = await fetch(`${API_URL}/api/user/export`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) throw new ApiError(res.status, 'EXPORT_FAILED', 'Could not export your data');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'duekeeper-export.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },
  async deleteAccount() {
    return request<void>('/api/user/profile', { method: 'DELETE' });
  },
  async revokeAllSessions() {
    return request<{ ok: boolean }>('/api/user/sessions/revoke-all', { method: 'POST' });
  },
  pushStatus() {
    return request<{ available: boolean; subscribedDevices: number }>('/api/user/push/status');
  },
  pushPublicKey() {
    return request<{ available: boolean; publicKey: string | null }>('/api/user/push/public-key');
  },
  pushSubscribe(dto: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    return request<{ ok: boolean }>('/api/user/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(dto)
    });
  },
  pushUnsubscribe(endpoint: string) {
    return request<{ ok: boolean }>('/api/user/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint })
    });
  },
  pushTest() {
    return request<{ sent: number; removed: number }>('/api/user/push/test', { method: 'POST' });
  }
};

export const calendarApi = {
  status() {
    return request<CalendarStatusResponse>('/api/calendar/status');
  },
  exportUrl() {
    return `${API_URL}/api/calendar/export.ics`;
  },
  importIcs(file: File) {
    const form = new FormData();
    form.append('file', file);
    return upload<{ imported: number; skipped: number }>('/api/calendar/import', form);
  },
  googleStartUrl() {
    return `${API_URL}/api/calendar/google/start`;
  },
  syncGoogle() {
    return request<{ imported: number; updated: number; scanned: number }>('/api/calendar/google/sync', {
      method: 'POST'
    });
  },
  disconnectGoogle() {
    return request<{ ok: boolean; wasConnected: boolean }>('/api/calendar/google', { method: 'DELETE' });
  }
};
