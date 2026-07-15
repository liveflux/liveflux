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

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

const linkCls =
  'rounded-full px-3 py-1.5 text-sm font-medium text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground';

/**
 * A centered, floating frosted-glass nav for the landing page — sticky at the top,
 * solidifies slightly on scroll. Brand + a live pulse (the same ping as the demo) +
 * Docs/Concepts/GitHub + theme toggle. Docs pages keep the standard Fumadocs sidebar nav.
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
          aria-label="GitHub"
          className="grid size-9 place-items-center rounded-full text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
        >
          <GitHubIcon className="size-4" />
        </a>
        <ThemeToggle />
      </nav>
    </div>
  );
}
