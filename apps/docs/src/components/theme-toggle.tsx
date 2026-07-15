'use client';

import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

/** No-op subscribe — lets useSyncExternalStore act as a client-mount flag (true on client, false on server). */
const emptySubscribe = () => () => {};

/**
 * Single-icon theme toggle: shows the Sun in light mode and the Moon in dark
 * mode, cross-fading on click. Fumadocs' built-in `light-dark` switch keeps
 * both icons in one pill — we want just one.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  // Client-only mount flag without setState-in-effect — avoids the icon's hydration mismatch.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className={[
        // borderless ghost icon button; rounded-full so the hover shape matches the
        // pill nav links and stays consistent across navs.
        'relative inline-flex size-9 items-center justify-center rounded-full',
        'text-fd-muted-foreground',
        'transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground cursor-pointer',
        className ?? '',
      ].join(' ')}
    >
      <Sun
        className={`size-5 transition-all duration-300 ${
          isDark ? 'scale-0 -rotate-90 opacity-0' : 'scale-100 rotate-0 opacity-100'
        }`}
        fill="currentColor"
      />
      <Moon
        className={`absolute size-5 transition-all duration-300 ${
          isDark ? 'scale-100 rotate-0 opacity-100' : 'scale-0 rotate-90 opacity-0'
        }`}
        fill="currentColor"
      />
    </button>
  );
}
