import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { Link } from 'expo-router';
import { useAuth } from '\.\./context/AuthContext';
import { theme } from '\.\./constants/theme';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.card}>
        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.subtitle}>Sign in to keep your deadlines under control.</Text>

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@example.com"
          placeholderTextColor={theme.inkSoft}
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="••••••••"
          placeholderTextColor={theme.inkSoft}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={[styles.button, busy && styles.disabled]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color={theme.white} /> : <Text style={styles.buttonText}>Sign in</Text>}
        </Pressable>

        <Text style={styles.footer}>
          New here?{' '}
          <Link href="/register" style={styles.link}>
            Create an account
          </Link>
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.surface, justifyContent: 'center', padding: 24 },
  card: {
    backgroundColor: theme.surfaceRaised,
    borderRadius: 20,
    padding: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.line
  },
  title: { fontSize: 22, fontWeight: '700', color: theme.ink },
  subtitle: { marginTop: 4, fontSize: 13, color: theme.inkSoft },
  label: {
    marginTop: 16,
    marginBottom: 6,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: theme.inkSoft
  },
  input: {
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: theme.ink,
    backgroundColor: theme.surface
  },
  error: {
    marginTop: 12,
    color: theme.danger,
    fontSize: 13,
    backgroundColor: 'rgba(226,72,92,0.08)',
    borderRadius: 10,
    padding: 10
  },
  button: {
    marginTop: 18,
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center'
  },
  disabled: { opacity: 0.6 },
  buttonText: { color: theme.white, fontWeight: '700', fontSize: 15 },
  footer: { marginTop: 18, textAlign: 'center', color: theme.inkSoft, fontSize: 13 },
  link: { color: theme.accent, fontWeight: '700' }
});
