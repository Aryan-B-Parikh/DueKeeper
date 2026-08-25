import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AuthProvider, useAuth } from '\.\./context/AuthContext';
import { theme } from '\.\./constants/theme';

function RootNavigator() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Deep link from notification tap → dashboard (P1). Mobile has no /event/[id] yet, so highlight via dashboard.
  // When eventId is present, the dashboard can scroll to it; for now just land on tabs.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
      const data = res.notification.request.content.data as Record<string, unknown> | undefined;
      const eventId = typeof data?.eventId === 'string' ? data.eventId : typeof data?.event_id === 'string' ? data.event_id : null;
      // TODO: when /event/[id] exists, push there; for now land on dashboard where notification is visible
      void eventId; // keep for future deep link
      router.push('/(tabs)' as never);
    });
    Notifications.getLastNotificationResponseAsync().then((res) => {
      const data = res?.notification.request.content.data as Record<string, unknown> | undefined;
      const eventId = typeof data?.eventId === 'string' ? data.eventId : null;
      if (eventId) router.push('/(tabs)' as never);
    });
    return () => sub.remove();
  }, [router]);

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === '(tabs)';
    if (!user && inAuthGroup) {
      router.replace('/login');
    } else if (user && !inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [user, loading, segments, router]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.surface }}>
        <ActivityIndicator color={theme.accent} size="large" />
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <RootNavigator />
    </AuthProvider>
  );
}
