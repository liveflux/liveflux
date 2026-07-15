import { getPageImage, source } from '@/lib/source';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { findNeighbour } from 'fumadocs-core/page-tree';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;

  // Prev/next comes from the page tree neighbours of the current url — DocsPage renders them
  // in its footer slot when handed `{ items: { previous, next } }`.
  const neighbours = findNeighbour(source.getPageTree(), page.url);

  // Note: the "Edit on GitHub" link is intentionally omitted for now — we're not taking
  // external doc contributions yet. Re-add it once the repo is public: render
  // `<EditOnGitHub href={.../blob/${branch}/apps/docs/content/docs/${page.path}} />` after
  // <DocsBody> (see SEO-GROWTH.md).

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} footer={{ items: neighbours }}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(
  props: PageProps<'/docs/[[...slug]]'>,
): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const image = {
    url: getPageImage(page).url,
    width: 1200,
    height: 630,
    alt: page.data.title,
  };

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url },
    openGraph: { images: [image] },
    twitter: { card: 'summary_large_image', images: [image] },
  };
}
