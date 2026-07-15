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
        {/* GitHub link intentionally omitted while the repo is private — re-add when public. */}
        <ThemeToggle />
      </nav>
    </div>
  );
}
