import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { ChevronDown, Menu } from 'lucide-react';
import { useRouter } from '../lib/router';
import { closePopoverGracefully } from '../lib/top-layer';
import { ThemeToggle } from './ThemeToggle';

type NavItem = {
  href: string;
  label: string;
  meta: string;
};

const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: '首页', meta: '太阳系' },
  { href: '/atlas', label: '旅图', meta: '地球' },
  { href: '/gallery', label: '影集', meta: '金星' },
  { href: '/observatory', label: '观星台', meta: '土星' },
  { href: '/projects', label: '展柜', meta: '木星' },
  { href: '/toolkit', label: '工具', meta: '水星' },
  { href: '/arcade', label: '游乐', meta: '火星' },
  { href: '/vault', label: '密匣', meta: '海王星' },
  { href: '/#labs', label: '实验馆', meta: '航路' },
  { href: '/admin', label: '整理台', meta: '后台' },
];

export function TopNav() {
  const { pathname, hash, navigate } = useRouter();
  const isHome = pathname === '/';
  const rawId = useId().replace(/[:]/g, '');
  const menuId = `home-nav-menu-${rawId}`;
  const popoverRef = useRef<HTMLUListElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [overHero, setOverHero] = useState(isHome);

  useEffect(() => {
    if (!isHome) {
      setMenuOpen(false);
      setOverHero(false);
      return;
    }
    const syncOverHero = () => {
      const heroEl = document.querySelector('main section[data-only-dark="true"]');
      if (heroEl) {
        setOverHero(heroEl.getBoundingClientRect().bottom > 48);
        return;
      }
      const threshold = Math.max(240, window.innerHeight - 56);
      setOverHero(window.scrollY < threshold);
    };
    syncOverHero();
    window.addEventListener('scroll', syncOverHero, { passive: true });
    window.addEventListener('resize', syncOverHero, { passive: true });

    const el = popoverRef.current;
    if (!el) {
      return () => {
        window.removeEventListener('scroll', syncOverHero);
        window.removeEventListener('resize', syncOverHero);
      };
    }
    const onToggle = (event: Event) => {
      const next = (event as Event & { newState?: string }).newState;
      let open = next === 'open';
      if (next === undefined) {
        try {
          open = el.matches(':popover-open') || el.classList.contains(':popover-open');
        } catch {
          open = el.classList.contains(':popover-open');
        }
      }
      setMenuOpen(open);
    };
    el.addEventListener('toggle', onToggle);
    return () => {
      window.removeEventListener('scroll', syncOverHero);
      window.removeEventListener('resize', syncOverHero);
      el.removeEventListener('toggle', onToggle);
    };
  }, [isHome]);

  const isCosmicFloating = isHome && overHero;

  const handleClick = (href: string, closePopover = false) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    if (closePopover) {
      void closePopoverGracefully(popoverRef.current);
    }
    navigate(href);
  };

  const resolveActive = (href: string) => {
    const isHashLabs = href === '/#labs';
    const isActive = isHashLabs
      ? pathname === '/' && hash === '#labs'
      : href === '/'
        ? pathname === '/' && hash !== '#labs'
        : pathname === href || pathname.startsWith(`${href}/`);
    return { isHashLabs, isActive };
  };

  return (
    <header
      className={`top-nav-shell sticky top-0 z-40 transition-colors duration-200 ${
        isCosmicFloating ? 'border-b border-transparent' : 'border-b border-hairline'
      }`}
      style={
        isCosmicFloating
          ? {
              height: 'var(--nav-height)',
              backgroundColor: 'transparent',
              backdropFilter: 'none',
              WebkitBackdropFilter: 'none',
            }
          : {
              height: 'var(--nav-height)',
              backgroundColor: 'var(--color-nav-glass)',
              backdropFilter: 'blur(14px)',
              WebkitBackdropFilter: 'blur(14px)',
            }
      }
    >
      <div
        className={
          isCosmicFloating
            ? 'flex h-full w-full items-center justify-between gap-3 px-4 sm:px-7'
            : 'mx-auto flex h-full max-w-[1280px] items-center justify-between gap-2 px-3 sm:gap-3 sm:px-6'
        }
      >
        <a
          href="/"
          onClick={handleClick('/', isHome)}
          className={
            isCosmicFloating
              ? 'inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full border border-white/15 bg-[#101420]/45 px-4 text-[14px] font-medium tracking-[0.01em] text-[#f1f3f4] no-underline shadow-[0_4px_20px_rgba(0,0,0,0.22)] backdrop-blur-md transition-colors hover:border-white/28 hover:bg-[#101420]/65 sm:h-10 sm:px-[18px] sm:text-[15px]'
              : 'shrink-0 whitespace-nowrap text-[14px] font-medium tracking-[-0.02em] text-ink no-underline sm:text-[15px]'
          }
        >
          旅途手记
        </a>

        <div className={`flex min-w-0 items-center ${isCosmicFloating ? 'gap-2.5 sm:gap-3' : 'flex-1 justify-end gap-2 sm:gap-4'}`}>
          {isHome ? (
            <nav aria-label="主导航" className="relative flex items-center">
              <button
                type="button"
                popoverTarget={menuId}
                popoverTargetAction="toggle"
                aria-controls={menuId}
                aria-expanded={menuOpen}
                className={
                  isCosmicFloating
                    ? 'home-nav-trigger inline-flex h-9 items-center gap-2 rounded-full border border-white/15 bg-[#101420]/45 px-4 text-[13.5px] font-medium text-[#f1f3f4] shadow-[0_4px_20px_rgba(0,0,0,0.22)] backdrop-blur-md transition-colors hover:border-white/28 hover:bg-[#101420]/65 sm:h-10 sm:px-[18px] sm:text-[14px]'
                    : 'home-nav-trigger inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-hairline bg-surface/85 px-3.5 text-[13px] font-medium text-ink transition-colors hover:border-hairline-strong hover:bg-surface-hover'
                }
              >
                <Menu
                  className={`${isCosmicFloating ? 'h-4 w-4 text-white/75' : 'h-3.5 w-3.5 text-ink-muted'}`}
                  aria-hidden="true"
                />
                <span>导航</span>
                <ChevronDown
                  className={`transition-transform duration-200 ${
                    isCosmicFloating ? 'h-4 w-4 text-white/75' : 'h-3.5 w-3.5 text-ink-muted'
                  } ${menuOpen ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </button>

              <ul
                id={menuId}
                ref={popoverRef}
                popover="auto"
                className="home-nav-popover m-0 list-none rounded-[18px] border border-hairline-strong bg-surface/95 p-2 shadow-xl backdrop-blur-xl"
              >
                {NAV_ITEMS.map((item) => {
                  const { isHashLabs, isActive } = resolveActive(item.href);
                  return (
                    <li key={item.href}>
                      <a
                        href={item.href}
                        onClick={handleClick(item.href, true)}
                        aria-current={!isHashLabs && isActive ? 'page' : undefined}
                        className={[
                          'flex items-center gap-2 rounded-[12px] px-3 py-2 text-[13.5px] no-underline transition-colors',
                          isActive
                            ? 'bg-surface-hover/85 font-medium text-ink'
                            : 'text-ink-muted hover:bg-surface-hover/70 hover:text-ink',
                        ].join(' ')}
                      >
                        <span
                          aria-hidden="true"
                          className={`home-nav-active-bar h-3.5 w-[2.5px] shrink-0 rounded-full transition-colors ${isActive ? 'bg-accent' : 'bg-transparent'}`}
                        />
                        <span className="flex-1">{item.label}</span>
                        <span className="text-[11.5px] text-ink-muted">{item.meta}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>
          ) : (
            <nav
              aria-label="主导航"
              className="top-nav-links flex min-w-0 items-center gap-2.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none] sm:gap-4 lg:gap-5 [&::-webkit-scrollbar]:hidden"
            >
              {NAV_ITEMS.map((item) => {
                const { isHashLabs, isActive } = resolveActive(item.href);

                return (
                  <a
                    key={item.href}
                    href={item.href}
                    onClick={handleClick(item.href)}
                    data-active={isActive ? 'true' : undefined}
                    aria-current={!isHashLabs && isActive ? 'page' : undefined}
                    className={[
                      'relative shrink-0 py-1.5 text-[12.5px] no-underline transition-colors sm:text-[14px]',
                      isActive ? 'font-medium text-ink' : 'text-ink-muted hover:text-ink',
                    ].join(' ')}
                  >
                    {item.label}
                    {isActive && (
                      <span
                        aria-hidden="true"
                        className="top-nav-fallback-bar pointer-events-none absolute right-0 bottom-0 left-0 h-0 rounded-full bg-accent opacity-0"
                      />
                    )}
                  </a>
                );
              })}
            </nav>
          )}

          <ThemeToggle variant={isCosmicFloating ? 'cosmic-glass' : 'default'} />
        </div>
      </div>
    </header>
  );
}
