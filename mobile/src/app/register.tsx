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

export default function RegisterScreen() {
  const { signUp } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password) || password.length < 8) {
      setError('Password needs 8+ characters with at least one letter and one number');
      return;
    }
    setBusy(true);
    try {
      await signUp(email.trim(), password, displayName.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.card}>
        <Text style={styles.title}>Create your account</Text>
        <Text style={styles.subtitle}>Free forever for personal deadline tracking.</Text>

        <Text style={styles.label}>Display name</Text>
        <TextInput style={styles.input} value={displayName} onChangeText={setDisplayName} placeholder="Alex Student" placeholderTextColor={theme.inkSoft} />

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
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
          placeholder="8+ chars, 1 letter, 1 number"
          placeholderTextColor={theme.inkSoft}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={[styles.button, busy && styles.disabled]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color={theme.white} /> : <Text style={styles.buttonText}>Create account</Text>}
        </Pressable>

        <Text style={styles.footer}>
          Already have an account?{' '}
          <Link href="/login" style={styles.link}>
            Sign in
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
