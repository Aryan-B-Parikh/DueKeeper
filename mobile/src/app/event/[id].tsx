import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { eventsApi, type EventItem } from '@/lib/api';
import { theme } from '@/constants/theme';

function formatDueFull(iso: string, _tz: string): string { try { return new Date(iso).toLocaleString(); } catch { return iso; } }
function formatDueRelative(iso: string): string { const diffH = Math.round((new Date(iso).getTime() - Date.now())/3600000); if (diffH>=0) return `in ${diffH>=48?`${Math.round(diffH/24)}d`:`${Math.max(1,diffH)}h`}`; return `${-diffH}h overdue`; }

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [event, setEvent] = useState<EventItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        // Mobile API doesn't have single-get yet; fetch all and find (deep link will be exact after we add get)
        const { events } = await eventsApi.list({ status: 'all' });
        const e = events.find((ev) => ev.id === String(id));
        if (!e) throw new Error('Deadline not found');
        if (alive) setEvent(e);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load deadline');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id]);

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={theme.accent} /></View>;
  }
  if (error || !event) {
    return (
      <>
        <Stack.Screen options={{ title: 'Deadline', headerBackTitle: 'Back' }} />
        <View style={styles.center}>
          <Text style={styles.error}>{error ?? 'Not found'}</Text>
          <Pressable onPress={() => router.replace('/(tabs)')} style={styles.backBtn}><Text style={styles.backText}>Go to dashboard</Text></Pressable>
        </View>
      </>
    );
  }

  const terminal = event.status === 'done' || event.status === 'cancelled';
  return (
    <>
      <Stack.Screen options={{ title: event.title.slice(0, 24), headerBackTitle: 'Back' }} />
      <View style={styles.container}>
        <View style={styles.card}>
          <Text style={[styles.title, terminal && { textDecorationLine: 'line-through', color: theme.inkSoft }]}>{event.title}</Text>
          <Text style={styles.sub}>{formatDueFull(event.dueAt, event.timezone)} · {formatDueRelative(event.dueAt)}</Text>
          {event.description ? <Text style={styles.desc}>{event.description}</Text> : null}
          <View style={styles.meta}>
            <Text style={styles.metaText}>{event.eventType} · {event.status}</Text>
          </View>
          <View style={styles.actions}>
            {!terminal && (
              <>
                <Pressable onPress={async () => { await eventsApi.markDone(event.id).catch(()=>{}); router.replace('/(tabs)'); }} style={styles.action}><Ionicons name="checkmark" size={16} color={theme.success} /><Text style={styles.actionText}>Done</Text></Pressable>
                <Pressable onPress={async () => { await eventsApi.snooze(event.id).catch(()=>{}); router.replace('/(tabs)'); }} style={styles.action}><Ionicons name="alarm-outline" size={16} color={theme.accent} /><Text style={styles.actionText}>Snooze</Text></Pressable>
              </>
            )}
            <Pressable onPress={() => router.replace('/(tabs)')} style={styles.backBtn}><Text style={styles.backText}>Back to dashboard</Text></Pressable>
          </View>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.surface, padding: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.surface, padding: 20, gap: 12 },
  card: { backgroundColor: theme.surfaceRaised, borderRadius: 16, padding: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line, gap: 8 },
  title: { fontSize: 18, fontWeight: '800', color: theme.ink },
  sub: { fontSize: 12, color: theme.inkSoft },
  desc: { fontSize: 14, color: theme.ink, marginTop: 4 },
  meta: { flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' },
  metaText: { fontSize: 12, color: theme.inkSoft },
  chip: { backgroundColor: theme.accentSoft, color: theme.accent, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, fontSize: 11, overflow: 'hidden' },
  actions: { flexDirection: 'row', gap: 12, marginTop: 12, flexWrap: 'wrap' },
  action: { flexDirection: 'row', gap: 4, alignItems: 'center', minHeight: 44, paddingHorizontal: 8 },
  actionText: { fontSize: 13, fontWeight: '600', color: theme.ink },
  error: { color: theme.danger, fontSize: 14, textAlign: 'center' },
  backBtn: { marginTop: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: theme.surfaceRaised, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line },
  backText: { color: theme.ink, fontWeight: '600' },
});
