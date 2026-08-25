import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

const CACHE_KEY = 'duekeeper:events:cache';
const SYNC_KEY = 'duekeeper:events:lastSynced';

export async function saveEventsCache(events: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(events));
    await AsyncStorage.setItem(SYNC_KEY, new Date().toISOString());
  } catch {}
}

export async function loadEventsCache<T>(): Promise<{ events: T[]; lastSynced: string | null }> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    const lastSynced = await AsyncStorage.getItem(SYNC_KEY);
    if (!raw) return { events: [], lastSynced };
    return { events: JSON.parse(raw) as T[], lastSynced };
  } catch {
    return { events: [], lastSynced: null };
  }
}

export async function isOnline(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    return Boolean(state.isConnected && state.isInternetReachable !== false);
  } catch {
    return true;
  }
}

export function formatLastSynced(iso: string | null): string {
  if (!iso) return 'Never synced';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'Last synced just now';
  if (diff < 3600_000) return `Last synced ${Math.round(diff/60000)}m ago`;
  if (diff < 86400_000) return `Last synced ${Math.round(diff/3600000)}h ago`;
  return `Last synced ${new Date(iso).toLocaleDateString()}`;
}
