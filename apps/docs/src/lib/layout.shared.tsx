import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName } from './shared';
import { ThemeToggle } from '@/components/theme-toggle';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold">
          {/* Solid brand fill via the theme-aware accent var — no gradient <defs> id,
              which Fumadocs' duplicated nav render would break (id collision → the
              mark went unfilled/white on light). Reliable on both themes. */}
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="var(--lf-accent)" />
            {/* stylised live "signal" pulse */}
            <path
              d="M6 16 h5 l3 -7 4 14 3 -7 h5"
              fill="none"
              stroke="#fff"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{appName}</span>
        </span>
      ),
    },
    // GitHub link omitted while the repo is private — re-add `githubUrl` when public.
    // single toggle whose icon swaps with the theme (Fumadocs' light-dark switch
    // keeps both icons in one pill — we supply our own one-icon toggle).
    themeSwitch: { component: <ThemeToggle /> },
  };
}
