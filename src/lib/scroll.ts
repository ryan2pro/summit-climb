/** Shared scroll helpers + nav metrics (used by Navbar, Footer, Home). */

export const NAV_HEIGHT = 64;

interface LenisLike {
  scrollTo: (target: HTMLElement, options?: { offset?: number; duration?: number }) => void;
}

/** Smooth-scroll to a section id — uses the landing Lenis instance when present. */
export function scrollToSection(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const lenis = (window as unknown as { __lenis?: LenisLike }).__lenis;
  if (lenis) {
    lenis.scrollTo(el, { offset: -NAV_HEIGHT, duration: 1.2 });
  } else {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
