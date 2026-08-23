import { getAccessToken, getRefreshToken, storeAuth, clearAuth } from './tokens';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8080';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let refreshInFlight: Promise<boolean> | null = null;

export async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refreshToken = await getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      });
      if (!res.ok) {
        await clearAuth();
        return false;
      }
      const pair = (await res.json()) as { accessToken: string; refreshToken: string };
      await storeAuth(pair.accessToken, pair.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>)
  };
  const token = await getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (res.status === 204) return undefined as T;

  if (res.status === 401 && retry && !path.startsWith('/api/auth/') && (await getRefreshToken())) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request<T>(path, options, false);
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

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  timezone: string;
  notificationPrefs: Record<string, boolean>;
  createdAt: string;
}

export interface AuthPayload {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export type EventType = 'exam' | 'submission' | 'hackathon' | 'other';
export type EventStatus = 'upcoming' | 'due_soon' | 'overdue' | 'done' | 'cancelled';

export interface Reminder {
  id?: string;
  offsetSeconds: number;
  channel: 'email' | 'in_app';
  enabled: boolean;
}

export interface EventItem {
  id: string;
  title: string;
  description: string | null;
  eventType: EventType;
  dueAt: string;
  timezone: string;
  status: EventStatus;
  reminders: Reminder[];
  createdAt: string;
  updatedAt: string;
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

export const authApi = {
  async login(email: string, password: string): Promise<AuthPayload> {
    const res = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    return handleAuthResponse(res);
  },
  async register(email: string, password: string, displayName: string): Promise<AuthPayload> {
    const res = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName })
    });
    return handleAuthResponse(res);
  },
  me() {
    return request<{ user: PublicUser }>('/api/auth/me');
  },
  async logout() {
    const refreshToken = await getRefreshToken();
    try {
      if (refreshToken) {
        await fetch(`${API_URL}/api/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken })
        });
      }
    } finally {
      await clearAuth();
    }
  }
};

async function handleAuthResponse(res: Response): Promise<AuthPayload> {
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? 'Authentication failed');
  }
  const payload = json as AuthPayload;
  await storeAuth(payload.accessToken, payload.refreshToken);
  return payload;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
}

export const eventsApi = {
  list(params: { status?: string } = {}) {
    return request<{ events: EventItem[] }>(`/api/events${qs({ status: params.status })}`);
  },
  create(input: {
    title: string;
    description?: string | null;
    eventType: EventType;
    dueAt: string;
    timezone: string;
    reminders?: Array<{ offsetSeconds: number; channel: 'email' | 'in_app' }>;
  }) {
    return request<{ event: EventItem }>('/api/events', { method: 'POST', body: JSON.stringify(input) });
  },
  markDone(id: string) {
    return request<{ event: EventItem }>(`/api/events/${id}/done`, { method: 'POST' });
  },
  snooze(id: string) {
    return request<{ event: EventItem }>(`/api/events/${id}/snooze`, {
      method: 'POST',
      body: JSON.stringify({ duration: '1d' })
    });
  },
  remove(id: string) {
    return request<void>(`/api/events/${id}`, { method: 'DELETE' });
  }
};

export const notificationsApi = {
  list(params: { limit?: number } = {}) {
    return request<{ notifications: AppNotification[]; unreadCount: number }>(
      `/api/notifications${qs({ limit: params.limit ?? 50 })}`
    );
  },
  markRead(id: string) {
    return request<{ ok: boolean }>(`/api/notifications/${id}/read`, { method: 'POST' });
  },
  markAllRead() {
    return request<{ ok: boolean }>('/api/notifications/read-all', { method: 'POST' });
  }
};

export const userApi = {
  pushRegisterExpo(token: string) {
    return request<{ ok: boolean }>('/api/user/push/expo', {
      method: 'POST',
      body: JSON.stringify({ token })
    });
  },
  pushUnregisterExpo(token: string) {
    return request<{ ok: boolean }>('/api/user/push/expo', {
      method: 'DELETE',
      body: JSON.stringify({ token })
    });
  },
  revokeAllSessions() {
    return request<{ ok: boolean }>('/api/user/sessions/revoke-all', { method: 'POST' });
  },
  async deleteAccount() {
    await request<void>('/api/user/profile', { method: 'DELETE' });
    await clearAuth();
  },
  updateProfile(input: { displayName?: string; timezone?: string }) {
    return request<{ user: PublicUser }>('/api/user/profile', {
      method: 'PUT',
      body: JSON.stringify(input)
    });
  }
};
