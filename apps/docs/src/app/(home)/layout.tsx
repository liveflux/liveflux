import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';
import { FloatingNav } from '@/components/floating-nav';

export default function Layout({ children }: LayoutProps<'/'>) {
  // The landing uses a custom centered floating nav instead of the default top bar.
  return (
    <HomeLayout {...baseOptions()} nav={{ enabled: false }}>
      <FloatingNav />
      {children}
    </HomeLayout>
  );
}
