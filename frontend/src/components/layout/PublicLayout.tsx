import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, Box } from 'lucide-react';
import type { ReactNode } from 'react';

const publicNav = [
  { label: 'Home', href: '/#home' },
  { label: 'Features', href: '/#features' },
  { label: 'About', href: '/#about' },
  { label: 'Contact', href: '/#contact' },
];

export function PublicLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <div className="min-h-screen overflow-hidden bg-[#03090d] text-neutral-100 selection:bg-emerald-400/30">
      <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-[#03090d]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between px-5 sm:px-8 lg:px-12">
          <Link to="/" className="flex items-center gap-3" aria-label="GlassHouse home">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-300/20 bg-emerald-400/[0.08] text-emerald-300 shadow-[0_0_28px_rgba(16,185,129,0.08)]">
              <Box size={24} strokeWidth={1.8} />
            </span>
            <span>
              <span className="block text-[17px] font-semibold tracking-tight">GlassHouse</span>
              <span className="hidden text-[11px] text-neutral-500 sm:block">Secure Sandboxed Execution</span>
            </span>
          </Link>

          <nav className="hidden items-center gap-9 md:flex" aria-label="Main navigation">
            {publicNav.map((item, index) => (
              <a
                key={item.label}
                href={item.href}
                className={`text-[13px] transition hover:text-emerald-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 ${index === 0 && location.pathname === '/' ? 'text-emerald-300' : 'text-neutral-400'}`}
              >
                {item.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2.5">
            <Link to="/login" className="hidden items-center gap-2 rounded-lg border border-emerald-300/30 px-4 py-2 text-[13px] font-medium text-neutral-200 transition hover:border-emerald-300/60 hover:bg-emerald-300/[0.06] sm:flex">
              Login
            </Link>
            <Link to="/register" className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-emerald-400 to-teal-300 px-4 py-2 text-[13px] font-semibold text-[#03120f] shadow-[0_8px_28px_rgba(16,185,129,0.15)] transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300">
              Get Started <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </header>

      {children}

      <footer id="contact" className="border-t border-white/[0.08] bg-[#03090d]">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-3 px-5 py-7 text-xs text-neutral-500 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-12">
          <span>© {new Date().getFullYear()} GlassHouse · Secure Sandboxed Execution</span>
          <span>Questions? Contact your GlassHouse administrator.</span>
        </div>
      </footer>
    </div>
  );
}
