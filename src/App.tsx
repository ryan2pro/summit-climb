import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Layout from '@/components/Layout';
import { ToastProvider } from '@/components/Toast';
import { SessionProvider } from '@/lib/session';
import Home from '@/pages/Home';
import Lobby from '@/pages/Lobby';

// Game page is lazy-loaded (Three.js engine chunk split from the landing).
const Game = lazy(() => import('@/pages/Game'));

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <SessionProvider>
        <ToastProvider>
          <Layout>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/lobby" element={<Lobby />} />
              <Route
                path="/game"
                element={
                  <Suspense
                    fallback={
                      <div className="flex min-h-[70dvh] items-center justify-center font-zh text-2xl text-ink-soft">
                        生成山峰中…
                      </div>
                    }
                  >
                    <Game />
                  </Suspense>
                }
              />
              <Route path="*" element={<Home />} />
            </Routes>
          </Layout>
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  );
}
