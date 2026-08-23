import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useAuth } from '../../context/AuthContext';
import { registerPushAndGetToken, disablePush } from '../../lib/push';
import { theme } from '../../constants/theme';

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const [pushState, setPushState] = useState<'unknown' | 'on' | 'off'>('unknown');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const settings = await Notifications.getPermissionsAsync().catch(() => null);
      setPushState(settings?.granted ? 'on' : 'off');
    })();
  }, []);

  async function enablePush() {
    setBusy(true);
    try {
      const token = await registerPushAndGetToken();
      setPushState(token ? 'on' : 'off');
    } catch {
      setPushState('off');
    } finally {
      setBusy(false);
    }
  }

  async function disablePushTap() {
    setBusy(true);
    try {
      await disablePush();
      await Notifications.getPermissionsAsync();
      setPushState('off');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Settings', headerShadowVisible: false }} />
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 }}>
        <Text style={styles.section}>Account</Text>
        <View style={styles.card}>
          <Text style={styles.value}>{user?.displayName}</Text>
          <Text style={styles.sub}>{user?.email}</Text>
        </View>

        <Text style={styles.section}>Push reminders</Text>
        <View style={styles.card}>
          <Text style={styles.sub}>
            {pushState === 'unknown' && 'Checking…'}
            {pushState === 'on' && 'Enabled on this device.'}
            {pushState === 'off' && 'Off. Enable to receive reminders even when the app is closed.'}
          </Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
            {pushState !== 'on' && (
              <Pressable style={[styles.btn, busy && styles.disabled]} onPress={enablePush} disabled={busy}>
                <Text style={styles.btnPrimaryText}>Enable push</Text>
              </Pressable>
            )}
            {pushState === 'on' && (
              <Pressable style={[styles.btnGhost, busy && styles.disabled]} onPress={disablePushTap} disabled={busy}>
                <Text style={styles.btnGhostText}>Disable</Text>
              </Pressable>
            )}
          </View>
        </View>

        <Text style={styles.section}>Session</Text>
        <View style={styles.card}>
          <Pressable
            onPress={() => void signOut()}
            style={[styles.btn, { backgroundColor: theme.danger }]}
          >
            <Text style={styles.btnPrimaryText}>Sign out</Text>
          </Pressable>
        </View>

        <Text style={styles.version}>DueKeeper mobile · v1.0.0</Text>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.surface },
  section: { marginTop: 20, marginBottom: 8, marginHorizontal: 16, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: theme.inkSoft },
  card: { backgroundColor: theme.surfaceRaised, borderRadius: 14, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line },
  value: { fontSize: 15, fontWeight: '700', color: theme.ink },
  sub: { marginTop: 4, fontSize: 13, color: theme.inkSoft },
  btn: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 11, paddingHorizontal: 18, alignItems: 'center', alignSelf: 'flex-start' },
  btnGhost: { backgroundColor: theme.surface, borderRadius: 12, paddingVertical: 11, paddingHorizontal: 18, alignItems: 'center', alignSelf: 'flex-start', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line },
  disabled: { opacity: 0.55 },
  btnPrimaryText: { color: theme.white, fontWeight: '700', fontSize: 13 },
  btnGhostText: { color: theme.inkSoft, fontWeight: '700', fontSize: 13 },
  version: { marginTop: 24, textAlign: 'center', fontSize: 11, color: theme.inkSoft, opacity: 0.7 }
});
