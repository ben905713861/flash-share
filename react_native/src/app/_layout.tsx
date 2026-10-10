import { DarkTheme, DefaultTheme, Slot, ThemeProvider } from 'expo-router';
import { ShareIntentProvider } from 'expo-share-intent';
import { useColorScheme } from 'react-native';
import { installLogger } from '@/lib/logger';

installLogger();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ShareIntentProvider options={{ resetOnBackground: false }}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Slot />
      </ThemeProvider>
    </ShareIntentProvider>
  );
}
