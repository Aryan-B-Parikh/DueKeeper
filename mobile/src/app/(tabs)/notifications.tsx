import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { notificationsApi, type AppNotification } from '../../lib/api';
import { theme } from '../../constants/theme';

export default function NotificationsScreen() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { notifications } = await notificationsApi.list();
      setItems(notifications);
    } catch {
      /* transient */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function markAll() {
    await notificationsApi.markAllRead().catch(() => undefined);
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Alerts',
          headerShadowVisible: false,
          headerRight: () => (
            <Pressable hitSlop={10} onPress={markAll}>
              <Text style={{ color: theme.accent, fontWeight: '700', fontSize: 13 }}>Mark all read</Text>
            </Pressable>
          )
        }}
      />
      <View style={styles.container}>
        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={theme.accent} />
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="notifications-off-outline" size={44} color={theme.inkSoft} />
            <Text style={styles.emptyTitle}>No alerts yet</Text>
            <Text style={styles.emptyBody}>Reminders will appear here as they fire.</Text>
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(n) => n.id}
            contentContainerStyle={{ paddingBottom: 24, gap: 8 }}
            renderItem={({ item }) => (
              <Pressable
                style={[styles.card, !item.read && styles.unread]}
                onPress={() => {
                  if (item.read) return;
                  setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)));
                  void notificationsApi.markRead(item.id).catch(() => undefined);
                }}
              >
                <Text style={[styles.title, item.read && styles.readTitle]}>{item.title}</Text>
                <Text style={styles.body}>{item.body}</Text>
                <Text style={styles.time}>{new Date(item.createdAt).toLocaleString()}</Text>
              </Pressable>
            )}
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.surface, paddingHorizontal: 16, paddingTop: 8 },
  empty: { alignItems: 'center', marginTop: 60, gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: theme.ink },
  emptyBody: { fontSize: 13, color: theme.inkSoft },
  card: { backgroundColor: theme.surfaceRaised, borderRadius: 14, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line },
  unread: { borderLeftWidth: 3, borderLeftColor: theme.accent },
  title: { fontSize: 14, fontWeight: '700', color: theme.ink },
  readTitle: { fontWeight: '500', color: theme.inkSoft },
  body: { marginTop: 4, fontSize: 13, color: theme.inkSoft },
  time: { marginTop: 6, fontSize: 11, color: theme.inkSoft, opacity: 0.7 }
});
