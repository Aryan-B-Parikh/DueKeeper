import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { userApi } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowList: true
  })
});

export async function registerPushAndGetToken(): Promise<string | null> {
  if (!Device.isDevice) return null;

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  if (!granted) {
    const asked = await Notifications.requestPermissionsAsync();
    granted = asked.granted;
  }
  if (!granted) return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('reminders', {
      name: 'Deadline reminders',
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: '#6d54eb'
    });
  }

  const token = await Notifications.getDevicePushTokenAsync();
  const value = String(token.data);
  await userApi.pushRegisterExpo(value);
  return value;
}

export async function disablePush(): Promise<void> {
  try {
    const token = await Notifications.getDevicePushTokenAsync();
    await userApi.pushUnregisterExpo(String(token.data));
  } catch {
    /* device token unavailable; nothing to unregister */
  }
}
