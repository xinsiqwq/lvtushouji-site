import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TopNav } from './components/TopNav';
import { RouterContext, type RouteState } from './lib/router';
import AtlasPage from './features/atlas/AtlasPage';
import HomePage from './features/home/HomePage';
import ObservatoryPage from './features/observatory/ObservatoryPage';
import VaultPage from './features/vault/VaultPage';

export { RouterContext, useRouter } from './lib/router';

const AdminPage = lazy(() => import('./features/admin/AdminPage'));
const ProjectsPage = lazy(() => import('./features/projects/ProjectsPage'));
const GalleryPage = lazy(() => import('./features/gallery/GalleryPage'));
const ToolkitPage = lazy(() => import('./features/toolkit/ToolkitPage'));
const ArcadePage = lazy(() => import('./features/arcade/ArcadePage'));
const ArenaPage = lazy(() => import('./features/arena/ArenaPage'));
const AmbienceDock = lazy(() => import('./features/toolkit/AmbienceDock'));
const PlanetComingSoonPage = lazy(() => import('./features/explore/PlanetComingSoonPage'));

function readLocation(): RouteState {
  if (typeof window === 'undefined') {
    return { pathname: '/', search: '', hash: '' };
  }
  const rawPath = window.location.pathname;
  const trimmed =
    rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const isLabs = trimmed === '/labs';
  const pathname =
    (isLabs
      ? '/'
      : trimmed === '/tools'
        ? '/toolkit'
        : trimmed === '/arena'
          ? '/arcade'
          : trimmed) || '/';
  const hash = isLabs ? '#labs' : window.location.hash;
  const search = window.location.search;
  const canonicalUrl = `${pathname}${search}${hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (canonicalUrl !== currentUrl) {
    window.history.replaceState(null, '', canonicalUrl);
  }
  return {
    pathname,
    search,
    hash,
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function focusRouteTarget(hash: string): void {
  if (typeof document === 'undefined') return;
  if (hash) {
    const id = hash.slice(1);
    const anchor = id ? document.getElementById(id) : null;
    if (anchor) {
      anchor.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      });
      if (anchor instanceof HTMLElement) {
        if (!anchor.hasAttribute('tabindex')) anchor.setAttribute('tabindex', '-1');
        anchor.focus({ preventScroll: true });
      }
      return;
    }
  }

  const heading = document.querySelector<HTMLElement>('#main-content h1');
  if (heading) {
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
    return;
  }

  const main = document.getElementById('main-content');
  main?.focus({ preventScroll: true });
}

function RouteSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="页面载入中"
      className="mx-auto flex min-h-[60vh] max-w-[1280px] items-center justify-center px-6 py-16 text-[14px] text-ink-muted"
    >
      正在展开这一页……
    </div>
  );
}

function NotFoundView({ onHome }: { onHome: () => void }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-[1280px] items-center justify-center px-6 py-16">
      <section className="max-w-[460px] rounded-[20px] bg-surface p-8">
        <h1 tabIndex={-1} className="text-[28px] font-medium tracking-[-0.03em] text-ink">
          页面走丢了
        </h1>
        <p className="mt-3 text-[15px] text-ink-muted">
          这里还没有记下足迹，可以先回到首页继续翻看。
        </p>
        <div className="mt-6">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onHome();
            }}
            className="pill-cta-primary"
          >
            回到首页
          </a>
        </div>
      </section>
    </div>
  );
}

type NavigationIntent = {
  id: number;
  hash: string;
  scrollToTop: boolean;
  transitionSettled: Promise<void>;
};

function RouteFocusBoundary({
  intent,
  initialHash,
  children,
}: {
  intent: NavigationIntent | null;
  initialHash: string;
  children: ReactNode;
}) {
  const handledInitialHashRef = useRef(false);

  useEffect(() => {
    if (!intent) {
      if (!initialHash || handledInitialHashRef.current) return;
      let cancelled = false;
      const rafId = window.requestAnimationFrame(() => {
        if (cancelled || handledInitialHashRef.current) return;
        handledInitialHashRef.current = true;
        const id = initialHash.slice(1);
        const anchor = id ? document.getElementById(id) : null;
        if (anchor) {
          anchor.scrollIntoView({ behavior: 'auto', block: 'start' });
          if (anchor instanceof HTMLElement) {
            if (!anchor.hasAttribute('tabindex')) anchor.setAttribute('tabindex', '-1');
            anchor.focus({ preventScroll: true });
          }
        }
      });
      return () => {
        cancelled = true;
        window.cancelAnimationFrame(rafId);
      };
    }

    handledInitialHashRef.current = true;
    let cancelled = false;
    let rafId = 0;

    if (intent.scrollToTop) {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
    focusRouteTarget(intent.hash);

    void intent.transitionSettled.then(() => {
      if (cancelled) return;
      rafId = window.requestAnimationFrame(() => {
        if (cancelled) return;
        if (intent.scrollToTop) {
          window.scrollTo({ top: 0, behavior: 'auto' });
        }
        if (!document.activeElement || !document.activeElement.closest('#main-content')) {
          focusRouteTarget(intent.hash);
        }
      });
    });

    return () => {
      cancelled = true;
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [intent, initialHash]);

  return <>{children}</>;
}

function routeOrder(pathname: string, hash: string): number {
  if (pathname === '/' && hash === '#labs') return 8;
  if (pathname.startsWith('/explore/')) return 8;
  switch (pathname) {
    case '/':
      return 0;
    case '/atlas':
      return 1;
    case '/gallery':
      return 2;
    case '/observatory':
      return 3;
    case '/projects':
      return 4;
    case '/toolkit':
    case '/tools':
      return 5;
    case '/arcade':
    case '/arcade/arena':
    case '/arena':
      return 6;
    case '/vault':
      return 7;
    case '/labs':
      return 8;
    case '/admin':
      return 9;
    default:
      return 10;
  }
}

export default function App() {
  const [route, setRoute] = useState<RouteState>(() => readLocation());
  const [initialHash] = useState(() => route.hash);
  const [navIntent, setNavIntent] = useState<NavigationIntent | null>(null);
  const navSeqRef = useRef(0);
  const routeOrderRef = useRef(routeOrder(route.pathname, route.hash));

  useEffect(() => {
    routeOrderRef.current = routeOrder(route.pathname, route.hash);
  }, [route.hash, route.pathname]);

  useEffect(() => {
    const handlePopState = () => {
      const next = readLocation();
      setRoute(next);
      setNavIntent({
        id: ++navSeqRef.current,
        hash: next.hash,
        scrollToTop: !next.hash,
        transitionSettled: Promise.resolve(),
      });
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback(
    (to: string, opts?: { replace?: boolean }) => {
      const targetUrl = new URL(to, window.location.origin);
      if (targetUrl.origin !== window.location.origin) {
        window.location.assign(targetUrl.href);
        return;
      }

      const rawPath = targetUrl.pathname;
      const trimmedPath =
        (rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath) || '/';
      const isLabs = trimmedPath === '/labs';
      const nextPath = isLabs
        ? '/'
        : trimmedPath === '/tools'
          ? '/toolkit'
          : trimmedPath === '/arena'
            ? '/arcade'
            : trimmedPath;
      const nextState: RouteState = {
        pathname: nextPath,
        search: targetUrl.search,
        hash: isLabs ? '#labs' : targetUrl.hash,
      };
      const finalUrl = `${nextState.pathname}${nextState.search}${nextState.hash}`;

      const sameDocumentPath =
        nextState.pathname === route.pathname && nextState.search === route.search;

      if (sameDocumentPath) {
        if (nextState.hash !== route.hash) {
          window.history.replaceState(null, '', finalUrl);
          setRoute(nextState);
        }
        setNavIntent({
          id: ++navSeqRef.current,
          hash: nextState.hash,
          scrollToTop: !nextState.hash,
          transitionSettled: Promise.resolve(),
        });
        return;
      }

      if (
        nextState.pathname === route.pathname &&
        (nextState.pathname === '/toolkit' ||
          nextState.pathname === '/arcade' ||
          nextState.pathname === '/arcade/arena') &&
        opts?.replace
      ) {
        window.history.replaceState(null, '', finalUrl);
        setRoute(nextState);
        return;
      }

      const nextOrder = routeOrder(nextState.pathname, nextState.hash);
      const direction = nextOrder < routeOrderRef.current ? 'backward' : 'forward';

      let settleTransition!: () => void;
      const transitionSettled = new Promise<void>((resolve) => {
        settleTransition = resolve;
      });
      const nextIntent: NavigationIntent = {
        id: ++navSeqRef.current,
        hash: nextState.hash,
        scrollToTop: !nextState.hash,
        transitionSettled,
      };

      let committed = false;
      const commitNavigation = () => {
        if (committed) return;
        committed = true;
        if (opts?.replace) {
          window.history.replaceState(null, '', finalUrl);
        } else {
          window.history.pushState(null, '', finalUrl);
        }
        setRoute(nextState);
        setNavIntent(nextIntent);
      };

      type ViewTransitionArg =
        | (() => void)
        | { update: () => void; types?: string[] };
      const doc = document as Document & {
        startViewTransition?: (arg: ViewTransitionArg) => { finished: Promise<void> };
      };
      const supportsTransitionTypes =
        typeof CSS !== 'undefined' &&
        typeof CSS.supports === 'function' &&
        CSS.supports('selector(:active-view-transition-type(forward))');

      if (
        typeof doc.startViewTransition === 'function' &&
        !document.hidden &&
        !prefersReducedMotion()
      ) {
        try {
          const transition = supportsTransitionTypes
            ? doc.startViewTransition({
                update: () => flushSync(commitNavigation),
                types: [direction],
              })
            : doc.startViewTransition(() => {
                flushSync(commitNavigation);
              });
          void transition.finished.finally(settleTransition);
        } catch {
          commitNavigation();
          settleTransition();
        }
      } else {
        commitNavigation();
        settleTransition();
      }
    },
    [route.hash, route.pathname, route.search],
  );

  const routerValue = useMemo(
    () => ({ ...route, navigate }),
    [route, navigate],
  );

  const renderPage = () => {
    switch (route.pathname) {
      case '/':
      case '/labs':
        return <HomePage />;
      case '/atlas':
        return <AtlasPage />;
      case '/gallery':
        return <GalleryPage />;
      case '/observatory':
        return <ObservatoryPage />;
      case '/projects':
        return <ProjectsPage />;
      case '/toolkit':
      case '/tools':
        return <ToolkitPage />;
      case '/arcade':
      case '/arena':
        return <ArcadePage />;
      case '/arcade/arena':
        return <ArenaPage />;
      case '/vault':
        return <VaultPage />;
      case '/admin':
        return <AdminPage />;
      default:
        if (route.pathname.startsWith('/explore/')) {
          return <PlanetComingSoonPage slug={route.pathname.slice('/explore/'.length)} />;
        }
        return <NotFoundView onHome={() => navigate('/')} />;
    }
  };

  const routeKey =
    route.pathname === '/toolkit' ||
    route.pathname === '/arcade' ||
    route.pathname === '/arcade/arena'
      ? route.pathname
      : `${route.pathname}${route.search}`;

  return (
    <RouterContext.Provider value={routerValue}>
      <div className="min-h-dvh flex flex-col">
        <TopNav />
        <main id="main-content" tabIndex={-1} className="page-transition-shell flex-1">
          <ErrorBoundary resetKey={routeKey}>
            <Suspense fallback={<RouteSkeleton />}>
              <RouteFocusBoundary key={routeKey} intent={navIntent} initialHash={initialHash}>
                {renderPage()}
              </RouteFocusBoundary>
            </Suspense>
          </ErrorBoundary>
        </main>
        {route.pathname !== '/arcade/arena' && (
          <Suspense fallback={null}>
            <AmbienceDock />
          </Suspense>
        )}
      </div>
    </RouterContext.Provider>
  );
}
