import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Header } from '../components/layout/Header';
import { AdminSidebar } from '../components/layout/AdminSidebar';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ToastContainer } from '../components/ui/Toast';
import { usePreferencesStore } from '../state/preferencesStore';
import { getResolvedTheme } from '../features/editor/editorOptions';

export function AdminLayout() {
  const theme = usePreferencesStore((state) => state.theme);
  const interfaceDensity = usePreferencesStore((state) => state.interfaceDensity);
  const reducedMotion = usePreferencesStore((state) => state.reducedMotion);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: light)');

    const applyTheme = () => {
      const resolvedTheme = getResolvedTheme(theme, media.matches);
      root.dataset.theme = resolvedTheme;
      root.style.colorScheme = resolvedTheme;
    };

    applyTheme();
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = interfaceDensity;
    root.dataset.reducedMotion = String(reducedMotion);
  }, [interfaceDensity, reducedMotion]);

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <Header />
      <div className="relative z-0 flex flex-1 overflow-hidden">
        <AdminSidebar />
        <main className="flex-1 overflow-auto bg-[#070b0e]">
          <Outlet />
        </main>
      </div>
      <ConfirmDialog />
      <ToastContainer />
    </div>
  );
}

