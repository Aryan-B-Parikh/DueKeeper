import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { Link, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { eventsApi, type EventItem } from '../../lib/api';
import { statusColors, theme } from '../../constants/theme';

const FILTERS = [
  { key: 'active', label: 'Active' },
  { key: 'due_soon', label: 'Due soon' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'done', label: 'Done' }
] as const;

export default function DashboardScreen() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('active');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { events: list } = await eventsApi.list({ status: filter });
      setEvents(list);
    } catch {
      /* keep previous list on transient failures */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return events;
    return events.filter((e) => e.title.toLowerCase().includes(q));
  }, [events, query]);

  async function act(action: () => Promise<unknown>) {
    await action().catch(() => undefined);
    await load();
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'DueKeeper',
          headerTitleStyle: { fontWeight: '800', color: theme.ink },
          headerShadowVisible: false,
          headerRight: () => (
            <Link href="/new-event" asChild>
              <Pressable hitSlop={12} style={styles.addButton}>
                <Ionicons name="add" size={22} color={theme.white} />
              </Pressable>
            </Link>
          )
        }}
      />
      <View style={styles.container}>
        <View style={styles.searchRow}>
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search deadlines…"
            placeholderTextColor={theme.inkSoft}
          />
        </View>

        <View style={styles.filters}>
          {FILTERS.map(({ key, label }) => (
            <Pressable key={key} onPress={() => setFilter(key)} style={[styles.chip, filter === key && styles.chipOn]}>
              <Text style={[styles.chipText, filter === key && styles.chipTextOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={theme.accent} />
        ) : visible.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="checkmark-done-circle-outline" size={44} color={theme.inkSoft} />
            <Text style={styles.emptyTitle}>Nothing here</Text>
            <Text style={styles.emptyBody}>Tap + to add your first deadline.</Text>
          </View>
        ) : (
          <FlatList
            data={visible}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingBottom: 24, gap: 10 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={theme.accent} />}
            renderItem={({ item }) => {
              const badge = statusColors[item.status] ?? statusColors.upcoming;
              const due = new Date(item.dueAt);
              const diffH = Math.round((due.getTime() - Date.now()) / 3_600_000);
              const rel = diffH >= 0 ? `in ${diffH >= 48 ? `${Math.round(diffH / 24)}d` : `${Math.max(1, diffH)}h`}` : `${-diffH}h overdue`;
              const terminal = item.status === 'done' || item.status === 'cancelled';
              return (
                <View style={styles.card}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={[styles.cardTitle, terminal && { textDecorationLine: 'line-through', color: theme.inkSoft }]} numberOfLines={1}>
                        {item.title}
                      </Text>
                      <View style={[styles.badge, { backgroundColor: badge.bg }]}>
                        <Text style={[styles.badgeText, { color: badge.text }]}>{badge.label}</Text>
                      </View>
                    </View>
                    <Text style={styles.cardSub}>
                      {due.toUTCString().slice(5, 22)} · {rel}
                    </Text>
                    {!terminal && (
                      <View style={styles.actions}>
                        <Pressable onPress={() => void act(() => eventsApi.markDone(item.id))} style={styles.action}>
                          <Ionicons name="checkmark" size={14} color={theme.success} />
                          <Text style={[styles.actionText, { color: theme.success }]}>Done</Text>
                        </Pressable>
                        <Pressable onPress={() => void act(() => eventsApi.snooze(item.id))} style={styles.action}>
                          <Ionicons name="alarm-outline" size={14} color={theme.accent} />
                          <Text style={[styles.actionText, { color: theme.accent }]}>Snooze 1d</Text>
                        </Pressable>
                        <Pressable onPress={() => void act(() => eventsApi.remove(item.id))} style={styles.action}>
                          <Ionicons name="trash-outline" size={14} color={theme.danger} />
                          <Text style={[styles.actionText, { color: theme.danger }]}>Delete</Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                </View>
              );
            }}
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.surface, paddingHorizontal: 16 },
  searchRow: { paddingTop: 8 },
  search: {
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: theme.ink,
    backgroundColor: theme.surfaceRaised
  },
  filters: { flexDirection: 'row', gap: 8, paddingVertical: 12, flexWrap: 'wrap' },
  chip: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: theme.surfaceRaised },
  chipOn: { backgroundColor: theme.accentSoft },
  chipText: { fontSize: 12, fontWeight: '600', color: theme.inkSoft },
  chipTextOn: { color: theme.accent },
  empty: { alignItems: 'center', marginTop: 60, gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: theme.ink },
  emptyBody: { fontSize: 13, color: theme.inkSoft },
  card: {
    backgroundColor: theme.surfaceRaised,
    borderRadius: 16,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.line
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: theme.ink, flexShrink: 1 },
  cardSub: { marginTop: 4, fontSize: 12, color: theme.inkSoft },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 10, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 14, marginTop: 10 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionText: { fontSize: 12, fontWeight: '600' },
  addButton: { backgroundColor: theme.accent, borderRadius: 10, width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }
});
