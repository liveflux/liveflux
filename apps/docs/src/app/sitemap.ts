import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

const SITE = 'https://liveflux.bpdm.dev';

export default function sitemap(): MetadataRoute.Sitemap {
  // No `lastModified` — a build-time `new Date()` would churn the sitemap on
  // every deploy and undercut static generation, so we omit it.
  return [
    {
      url: new URL('/', SITE).toString(),
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    ...source.getPages().map((page) => ({
      url: new URL(page.url, SITE).toString(),
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
  ];
}
