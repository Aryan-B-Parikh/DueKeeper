import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { eventsApi } from '../lib/api';
import { theme } from '../constants/theme';
import { enqueueOffline, syncQueue } from '../lib/offlineQueue';
import { isOnline } from '../lib/offline';

const TYPES = ['exam', 'submission', 'hackathon', 'other'] as const;

export default function NewEventScreen() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [eventType, setEventType] = useState<(typeof TYPES)[number]>('other');
  const [due, setDue] = useState(() => {
    const d = new Date(Date.now() + 24 * 3600_000);
    d.setSeconds(0, 0);
    return d;
  });
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (title.trim().length === 0) {
      setError('Give the deadline a title');
      return;
    }
    setBusy(true);
    setError(null);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try {
      await eventsApi.create({
        title: title.trim(),
        eventType,
        dueAt: due.toISOString(),
        timezone: tz,
        reminders: [
          { offsetSeconds: 86_400, channel: 'in_app' },
          { offsetSeconds: 3_600, channel: 'in_app' }
        ]
      });
      router.replace('/(tabs)');
    } catch (err) {
      const online = await isOnline();
      if (!online) {
        await enqueueOffline({ title: title.trim(), eventType, dueAt: due.toISOString(), timezone: tz });
        setError('No internet — saved locally. Will sync when back online (pull to refresh on dashboard).');
        // Try sync in background when online
        void syncQueue();
      } else {
        setError(err instanceof Error ? err.message : 'Could not create deadline');
      }
      setBusy(false);
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'New deadline',
          headerShadowVisible: false,
          headerLeft: () => (
            <Pressable hitSlop={12} onPress={() => router.back()}>
              <Ionicons name="close" size={24} color={theme.ink} />
            </Pressable>
          )
        }}
      />
      <View style={styles.container}>
        <Text style={styles.label}>Title</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="DBMS midterm" placeholderTextColor={theme.inkSoft} />

        <Text style={styles.label}>Type</Text>
        <View style={styles.types}>
          {TYPES.map((t) => (
            <Pressable key={t} onPress={() => setEventType(t)} style={[styles.typeChip, eventType === t && styles.typeOn]}>
              <Text style={[styles.typeText, eventType === t && styles.typeTextOn]}>{t}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>Due date & time</Text>
        <Pressable style={styles.dateButton} onPress={() => setShowPicker(true)}>
          <Ionicons name="calendar-outline" size={18} color={theme.accent} />
          <Text style={styles.dateText}>{due.toLocaleString()}</Text>
        </Pressable>
        {showPicker && (
          <DateTimePicker
            value={due}
            mode="datetime"
            is24Hour={false}
            onChange={(_e, selected) => {
              setShowPicker(Platform.OS === 'ios');
              if (selected) setDue(selected);
            }}
          />
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={[styles.submit, busy && styles.disabled]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color={theme.white} /> : <Text style={styles.submitText}>Create deadline</Text>}
        </Pressable>
        <Text style={styles.hint}>Default reminders: 1 day and 1 hour before.</Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.surface, padding: 20, gap: 2 },
  label: { marginTop: 14, marginBottom: 6, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: theme.inkSoft },
  input: { borderWidth: 1, borderColor: theme.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: theme.ink, backgroundColor: theme.surfaceRaised },
  types: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  typeChip: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: theme.surfaceRaised },
  typeOn: { backgroundColor: theme.accentSoft },
  typeText: { fontSize: 13, fontWeight: '600', color: theme.inkSoft, textTransform: 'capitalize' },
  typeTextOn: { color: theme.accent },
  dateButton: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: theme.line, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: theme.surfaceRaised },
  dateText: { fontSize: 15, color: theme.ink },
  error: { marginTop: 10, color: theme.danger, fontSize: 13 },
  submit: { marginTop: 22, backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  disabled: { opacity: 0.6 },
  submitText: { color: theme.white, fontWeight: '700', fontSize: 15 },
  hint: { marginTop: 10, textAlign: 'center', fontSize: 12, color: theme.inkSoft }
});
