'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ThemeToggle } from './theme-toggle';

/** Brand signal-pulse mark, filled with the theme-aware accent. */
function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="8" fill="var(--lf-accent)" />
      <path
        d="M6 16 h5 l3 -7 4 14 3 -7 h5"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const linkCls =
  'rounded-full px-3 py-1.5 text-sm font-medium text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground';

/**
 * A centered, floating frosted-glass nav for the landing page — sticky at the top,
 * solidifies slightly on scroll. Brand + a live pulse (the same ping as the demo) +
 * Docs/Concepts + theme toggle. Docs pages keep the standard Fumadocs sidebar nav.
 */
export function FloatingNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
      <nav
        aria-label="Main"
        className={[
          'pointer-events-auto flex items-center gap-1 rounded-full border backdrop-blur-md transition-all duration-300',
          scrolled
            ? 'border-fd-border bg-fd-background/85 py-1 pl-2 pr-1.5 shadow-lg'
            : 'border-fd-border/60 bg-fd-background/60 py-1.5 pl-3 pr-2 shadow-md',
        ].join(' ')}
      >
        {/* brand + live pulse — reads "Liveflux, live" */}
        <Link href="/" className="flex items-center gap-2 pr-1 font-semibold" aria-label="Liveflux home">
          <Mark className="size-5" />
          <span className="hidden sm:inline">Liveflux</span>
          <span className="relative flex size-2 items-center justify-center" aria-hidden="true">
            <span
              className="absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:hidden"
              style={{ backgroundColor: 'var(--lf-accent)' }}
            />
            <span
              className="relative inline-flex size-1.5 rounded-full"
              style={{ backgroundColor: 'var(--lf-accent)' }}
            />
          </span>
        </Link>

        <span className="mx-1 h-5 w-px bg-fd-border" aria-hidden="true" />

        <Link href="/docs" className={linkCls}>
          Docs
        </Link>
        <Link href="/docs/concepts" className={linkCls}>
          Concepts
        </Link>
        <a
          href="https://github.com/liveflux/liveflux"
          target="_blank"
          rel="noreferrer"
          aria-label="Liveflux on GitHub"
          className="inline-flex size-9 items-center justify-center rounded-full text-fd-muted-foreground transition-colors hover:text-fd-foreground"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-4">
            <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.2 11.16.6.1.82-.25.82-.56v-2c-3.34.72-4.04-1.6-4.04-1.6-.55-1.36-1.33-1.73-1.33-1.73-1.09-.73.08-.72.08-.72 1.2.08 1.83 1.22 1.83 1.22 1.07 1.8 2.8 1.28 3.49.98.1-.76.42-1.28.76-1.57-2.67-.3-5.47-1.31-5.47-5.84 0-1.29.47-2.35 1.24-3.18-.13-.3-.54-1.51.11-3.15 0 0 1.01-.32 3.3 1.21a11.6 11.6 0 016 0c2.29-1.53 3.3-1.21 3.3-1.21.65 1.64.24 2.85.11 3.15.77.83 1.24 1.89 1.24 3.18 0 4.54-2.81 5.54-5.48 5.83.43.37.81 1.1.81 2.22v3.29c0 .32.21.68.82.56A12.01 12.01 0 0024 12.29C24 5.78 18.63.5 12 .5z" />
          </svg>
        </a>
        <ThemeToggle />
      </nav>
    </div>
  );
}
