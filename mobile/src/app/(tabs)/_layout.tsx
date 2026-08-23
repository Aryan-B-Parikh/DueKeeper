import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../../constants/theme';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.inkSoft,
        tabBarStyle: { backgroundColor: theme.surfaceRaised, borderTopColor: theme.line }
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Deadlines',
          tabBarIcon: ({ color, size }) => <Ionicons name="time-outline" size={size} color={color} />
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Alerts',
          tabBarIcon: ({ color, size }) => <Ionicons name="notifications-outline" size={size} color={color} />
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" size={size} color={color} />
        }}
      />
    </Tabs>
  );
}
