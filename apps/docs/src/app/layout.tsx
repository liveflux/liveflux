import type { Metadata, Viewport } from 'next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter } from 'next/font/google';

const inter = Inter({
  subsets: ['latin'],
});

const SITE = 'https://liveflux.bpdm.dev';
const TITLE = 'Liveflux — typed, reconnect-safe realtime streaming state';
const DESCRIPTION =
  'Liveflux turns a live connection (WebSocket, Phoenix Channels, and more via adapters) into declarative, typed UI state — protocol-agnostic via adapters, framework-agnostic via bindings. Stop hand-rolling sockets, cache glue, dedup, backpressure, and reconnect logic.';

// Site-level OpenGraph image: reuse the per-page OG generator, pointed at the
// docs intro page (index.mdx → empty slug → /og/docs/image.png). Object form so
// crawlers get explicit dimensions + alt text for the social card.
const DEFAULT_OG_IMAGE = {
  url: '/og/docs/image.png',
  width: 1200,
  height: 630,
  alt: 'Liveflux — typed, reconnect-safe realtime streaming state',
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: TITLE,
    template: '%s · Liveflux',
  },
  description: DESCRIPTION,
  applicationName: 'Liveflux',
  // The `keywords` meta tag carries little weight with Google — real ranking
  // comes from titles, descriptions, headings, and structured data. It's cheap
  // and harmless to include a focused, honest set of natural search terms.
  keywords: [
    'liveflux',
    'websocket',
    'websockets',
    'realtime',
    'real-time',
    'socket',
    'realtime state',
    'realtime state management',
    'websocket state management',
    'react websocket',
    'react websocket hook',
    'websocket react hook',
    'useStream',
    'reconnecting websocket',
    'websocket reconnect',
    'auto reconnect websocket',
    'phoenix channels',
    'phoenix channels client',
    'phoenix channels react',
    'streaming state',
    'live data',
    'realtime react',
    'typescript websocket',
    'typed realtime',
    'websocket client',
    'multiplexed websocket',
    'backpressure',
    'tear-free',
    'useSyncExternalStore',
  ],
  authors: [{ name: 'Bhavin Devamorari', url: 'https://bpdm.dev' }],
  creator: 'Liveflux',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE,
    siteName: 'Liveflux',
    title: TITLE,
    description: DESCRIPTION,
    images: DEFAULT_OG_IMAGE,
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: DEFAULT_OG_IMAGE,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      {/* suppressHydrationWarning: browser extensions inject attributes on <body>
          that aren't in the SSR'd HTML. */}
      <body className="flex flex-col min-h-screen" suppressHydrationWarning>
        <RootProvider
          theme={{
            attribute: 'class',
            defaultTheme: 'dark',
            enableSystem: true,
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
