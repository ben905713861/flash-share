import { DarkTheme, DefaultTheme, Slot, ThemeProvider } from 'expo-router';
import { ShareIntentProvider } from 'expo-share-intent';
import { useColorScheme } from 'react-native';
import { useEffect } from 'react';
import { installLogger } from '@/lib/logger';
import { checkForTauriUpdate } from '@/lib/tauri-updater';

installLogger();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  useEffect(() => {
    void checkForTauriUpdate();
  }, []);
  return (
    <ShareIntentProvider options={{ resetOnBackground: false }}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Slot />
      </ThemeProvider>
    </ShareIntentProvider>
  );
}
