import type { ReactNode } from 'react';
import Navbar from '@/components/Navbar';
import { NAV_HEIGHT } from '@/lib/scroll';

/**
 * App shell (children pattern): fixed Navbar + content slot with matching
 * top padding. Full-bleed hero sections opt out of the offset inside the
 * page with a negative top margin (e.g. `-mt-16`).
 */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-paper">
      <Navbar />
      <main style={{ paddingTop: NAV_HEIGHT }}>{children}</main>
    </div>
  );
}
