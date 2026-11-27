import { useEffect, useId, useRef, type CSSProperties } from 'react';

export type CelestialBackdropVariant =
  | 'admin-login'
  | 'admin-workspace'
  | 'vault'
  | 'home-lower'
  | 'subtle-header';

type CelestialFieldBackdropProps = {
  variant: CelestialBackdropVariant;
};

type GridConfig = {
  baseOpacity: number;
  motifOpacity: number;
  maskCenter: boolean;
  heightClass?: string;
};

const VARIANT_CONFIG: Record<CelestialBackdropVariant, GridConfig> = {
  'admin-login': {
    baseOpacity: 0.95,
    motifOpacity: 0.98,
    maskCenter: true,
  },
  'admin-workspace': {
    baseOpacity: 0.56,
    motifOpacity: 0.56,
    maskCenter: true,
  },
  vault: {
    baseOpacity: 0.92,
    motifOpacity: 0.96,
    maskCenter: true,
  },
  'home-lower': {
    baseOpacity: 0.72,
    motifOpacity: 0.82,
    maskCenter: false,
  },
  'subtle-header': {
    baseOpacity: 0.68,
    motifOpacity: 0.72,
    maskCenter: false,
    heightClass: 'h-[156px]',
  },
};

/**
 * Original theme-authentic cartographic, darkroom, and celestial backdrop.
 * Uses radial cursor lantern reveals on fine-pointer devices with zero continuous JS RAF loop.
 */
export function CelestialFieldBackdrop({ variant }: CelestialFieldBackdropProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rawId = useId().replace(/[:]/g, '');
  const gridPatternId = `celestial-grid-${rawId}`;
  const finePatternId = `celestial-fine-${rawId}`;
  const config = VARIANT_CONFIG[variant];

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const canTrack =
      window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
      window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
    if (!canTrack) return;

    let frameId = 0;
    let nextClientX = 0;
    let nextClientY = 0;
    let cachedRect: DOMRect | null = null;
    let rectDirty = true;
    let wasActive = false;

    const markRectDirty = () => {
      rectDirty = true;
    };

    const commit = () => {
      frameId = 0;
      if (rectDirty || !cachedRect) {
        cachedRect = el.getBoundingClientRect();
        rectDirty = false;
      }
      const rect = cachedRect;
      if (rect.width <= 0 || rect.height <= 0) return;

      const x = nextClientX - rect.left;
      const y = nextClientY - rect.top;
      const insideBand = x >= -100 && x <= rect.width + 100 && y >= -100 && y <= rect.height + 100;
      if (!insideBand && !wasActive) {
        return;
      }

      if (!insideBand) {
        wasActive = false;
        el.style.setProperty('--lantern-active', '0');
        el.style.setProperty('--px', '0');
        el.style.setProperty('--py', '0');
        return;
      }

      wasActive = true;
      const px = Math.max(-1, Math.min(1, (x / rect.width) * 2 - 1));
      const py = Math.max(-1, Math.min(1, (y / rect.height) * 2 - 1));

      el.style.setProperty('--lantern-x', `${x.toFixed(1)}px`);
      el.style.setProperty('--lantern-y', `${y.toFixed(1)}px`);
      el.style.setProperty('--lantern-active', '1');
      el.style.setProperty('--px', px.toFixed(3));
      el.style.setProperty('--py', py.toFixed(3));
    };

    const onPointerMove = (event: PointerEvent) => {
      nextClientX = event.clientX;
      nextClientY = event.clientY;
      if (!frameId) {
        frameId = window.requestAnimationFrame(commit);
      }
    };

    const onPointerLeave = () => {
      if (!wasActive) return;
      wasActive = false;
      el.style.setProperty('--lantern-active', '0');
      el.style.setProperty('--px', '0');
      el.style.setProperty('--py', '0');
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerleave', onPointerLeave, { passive: true });
    window.addEventListener('scroll', markRectDirty, { passive: true });
    window.addEventListener('resize', markRectDirty, { passive: true });

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('scroll', markRectDirty);
      window.removeEventListener('resize', markRectDirty);
    };
  }, []);

  const maskStyle: CSSProperties = config.maskCenter
    ? {
        WebkitMaskImage:
          'radial-gradient(ellipse 56% 52% at 50% 48%, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.78) 54%, rgba(0,0,0,1) 100%)',
        maskImage:
          'radial-gradient(ellipse 56% 52% at 50% 48%, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.78) 54%, rgba(0,0,0,1) 100%)',
      }
    : variant === 'subtle-header'
      ? {
          WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0) 100%)',
          maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0) 100%)',
        }
      : {
          WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0.96) 14%, rgba(0,0,0,0.96) 88%, rgba(0,0,0,0.24) 100%)',
          maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0.96) 14%, rgba(0,0,0,0.96) 88%, rgba(0,0,0,0.24) 100%)',
        };

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className={[
        'celestial-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 overflow-hidden select-none',
        config.heightClass ?? 'bottom-0',
      ].join(' ')}
    >
      {/* Layer 1: Cartographic meridian grid + 56px survey crosslines & intersection dots */}
      <div className="absolute inset-0" style={{ opacity: config.baseOpacity, ...maskStyle }}>
        <svg className="h-full w-full" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id={gridPatternId} width="112" height="112" patternUnits="userSpaceOnUse">
              <path
                d="M 112 0 L 0 0 0 112"
                fill="none"
                stroke="var(--color-hairline)"
                strokeWidth="1"
              />
              <path
                d="M 56 0 L 56 112 M 0 56 L 112 56"
                fill="none"
                stroke="var(--color-hairline)"
                strokeOpacity="0.48"
                strokeWidth="0.75"
                strokeDasharray="1 5"
              />
              <path
                d="M 108 0 L 112 0 M 0 108 L 0 112 M -4 0 L 4 0 M 0 -4 L 0 4 M 52 56 L 60 56 M 56 52 L 56 60"
                fill="none"
                stroke="var(--color-hairline-strong)"
                strokeWidth="1"
                opacity="0.78"
              />
              <circle cx="0" cy="0" r="1.2" fill="var(--color-hairline-strong)" fillOpacity="0.7" />
              <circle cx="56" cy="56" r="1" fill="var(--color-hairline-strong)" fillOpacity="0.55" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${gridPatternId})`} />
        </svg>
      </div>

      {/* Layer 2: Rich theme-authentic cartographic, lunar, mountain & astronomical drafting motifs */}
      {variant === 'subtle-header' ? (
        <div className="absolute inset-0" style={{ opacity: config.motifOpacity, ...maskStyle }}>
          <svg
            viewBox="0 0 1440 156"
            preserveAspectRatio="xMidYMid slice"
            className="h-full w-full"
          >
            <g fill="none">
              <path
                d="M -40 118 Q 380 34 740 82 T 1480 48"
                stroke="var(--color-accent)"
                strokeOpacity="0.28"
                strokeWidth="1"
                strokeDasharray="4 6"
                className="celestial-dash-drift"
              />
              <line x1="120" y1="24" x2="1320" y2="24" stroke="var(--color-hairline-strong)" strokeOpacity="0.4" strokeWidth="0.75" />
              <circle cx="280" cy="70" r="1.8" fill="var(--color-accent)" fillOpacity="0.5" />
              <circle cx="620" cy="70" r="2.2" fill="var(--color-postmark)" fillOpacity="0.55" />
              <circle cx="1090" cy="64" r="1.8" fill="var(--color-accent)" fillOpacity="0.5" />
              <circle cx="1220" cy="48" r="16" stroke="var(--color-postmark)" strokeOpacity="0.25" strokeDasharray="3 4" />
            </g>
          </svg>
        </div>
      ) : (
        <div className="absolute inset-0" style={{ opacity: config.motifOpacity, ...maskStyle }}>
          {/* Ambient soft color pools echoing warm postmark & celestial accent */}
          <div
            className="celestial-float-slow absolute -top-24 -left-20 h-[420px] w-[420px] rounded-full opacity-55"
            style={{
              background:
                'radial-gradient(circle, color-mix(in srgb, var(--color-accent) 13%, transparent) 0%, transparent 70%)',
            }}
          />
          <div
            className="celestial-float-reverse absolute -right-20 -bottom-24 h-[440px] w-[440px] rounded-full opacity-50"
            style={{
              background:
                'radial-gradient(circle, color-mix(in srgb, var(--color-postmark) 14%, transparent) 0%, transparent 70%)',
            }}
          />

          {/* Full-canvas sweeping celestial meridians & geographic margin tick rulers */}
          <svg
            viewBox="0 0 1440 900"
            preserveAspectRatio="xMidYMid slice"
            className="pointer-events-none absolute inset-0 h-full w-full"
          >
            <g fill="none">
              {/* Sweeping ecliptic & great-circle meridian arcs */}
              <path
                d="M -60 720 Q 520 140 1500 260"
                stroke="var(--color-accent)"
                strokeOpacity="0.22"
                strokeWidth="1.1"
                strokeDasharray="5 7"
                className="celestial-dash-drift"
              />
              <path
                d="M -80 210 C 390 480 960 440 1510 740"
                stroke="var(--color-postmark)"
                strokeOpacity="0.24"
                strokeWidth="1.05"
                strokeDasharray="3 8"
              />
              <circle cx="332" cy="434" r="2.8" fill="var(--color-accent)" fillOpacity="0.46" />
              <circle cx="1098" cy="238" r="3" fill="var(--color-postmark)" fillOpacity="0.5" />
              <circle cx="1098" cy="238" r="8" stroke="var(--color-postmark)" strokeOpacity="0.24" />

              {/* Top & bottom longitude vernier scales */}
              <line x1="180" y1="18" x2="1260" y2="18" stroke="var(--color-ink)" strokeOpacity="0.16" strokeWidth="0.8" />
              {[
                { x: 320, label: '90°E' },
                { x: 720, label: '100°E' },
                { x: 1120, label: '110°E' },
              ].map((tick) => (
                <g key={tick.label}>
                  <line x1={tick.x} y1="12" x2={tick.x} y2="26" stroke="var(--color-ink)" strokeOpacity="0.32" strokeWidth="1" />
                  <text
                    x={tick.x + 6}
                    y="23"
                    fill="var(--color-ink-muted)"
                    fillOpacity="0.52"
                    fontSize="9.5"
                    className="tabular-nums-mono"
                  >
                    {tick.label}
                  </text>
                </g>
              ))}

              {/* Left & right latitude survey vernier tick rulers */}
              <line x1="22" y1="180" x2="22" y2="720" stroke="var(--color-ink)" strokeOpacity="0.16" strokeWidth="0.8" />
              <line x1="1418" y1="180" x2="1418" y2="720" stroke="var(--color-ink)" strokeOpacity="0.16" strokeWidth="0.8" />
              {[
                { y: 240, label: '40°N' },
                { y: 450, label: '35°N' },
                { y: 660, label: '30°N' },
              ].map((tick) => (
                <g key={tick.label}>
                  <line x1="14" y1={tick.y} x2="28" y2={tick.y} stroke="var(--color-ink)" strokeOpacity="0.3" strokeWidth="1" />
                  <line x1="1412" y1={tick.y} x2="1426" y2={tick.y} stroke="var(--color-ink)" strokeOpacity="0.3" strokeWidth="1" />
                  <text
                    x="34"
                    y={tick.y + 3}
                    fill="var(--color-ink-muted)"
                    fillOpacity="0.48"
                    fontSize="9.5"
                    className="tabular-nums-mono"
                  >
                    {tick.label}
                  </text>
                </g>
              ))}
            </g>
          </svg>

          {/* Top-center-left: 5-phase Lunar Ephemeris sequence bar */}
          <svg
            viewBox="0 0 280 56"
            className="celestial-float-slow absolute top-6 left-[22%] hidden h-[44px] w-[220px] md:block"
          >
            <g fill="none">
              <line x1="18" y1="22" x2="262" y2="22" stroke="var(--color-ink)" strokeOpacity="0.2" strokeWidth="0.9" strokeDasharray="2 4" />
              {/* Crescent -> Quarter -> Full -> Waning -> Crescent */}
              <circle cx="42" cy="22" r="8" stroke="var(--color-ink)" strokeOpacity="0.34" strokeWidth="1" />
              <path d="M42 14 A8 8 0 0 1 42 30 A4.5 8 0 0 0 42 14 Z" fill="var(--color-accent)" fillOpacity="0.35" />

              <circle cx="92" cy="22" r="8" stroke="var(--color-ink)" strokeOpacity="0.38" strokeWidth="1" />
              <path d="M92 14 A8 8 0 0 1 92 30 Z" fill="var(--color-accent)" fillOpacity="0.42" />

              <circle cx="142" cy="22" r="9.5" stroke="var(--color-postmark)" strokeOpacity="0.52" strokeWidth="1.1" />
              <circle cx="142" cy="22" r="5.5" fill="var(--color-postmark)" fillOpacity="0.36" />

              <circle cx="192" cy="22" r="8" stroke="var(--color-ink)" strokeOpacity="0.38" strokeWidth="1" />
              <path d="M192 14 A8 8 0 0 0 192 30 Z" fill="var(--color-accent)" fillOpacity="0.42" />

              <circle cx="242" cy="22" r="8" stroke="var(--color-ink)" strokeOpacity="0.34" strokeWidth="1" />
              <path d="M242 14 A8 8 0 0 0 242 30 A4.5 8 0 0 1 242 14 Z" fill="var(--color-accent)" fillOpacity="0.35" />

              <text
                x="142"
                y="48"
                textAnchor="middle"
                fill="var(--color-ink-muted)"
                fillOpacity="0.6"
                fontSize="9.5"
                className="tabular-nums-mono"
              >
                J2000 · LUNAR
              </text>
            </g>
          </svg>

          {/* Top-center-right: Cassiopeia / Orion triangulation star trace with Bayer labels */}
          <svg
            viewBox="0 0 250 100"
            className="celestial-float-reverse absolute top-8 right-[24%] hidden h-[86px] w-[215px] md:block"
          >
            <g>
              <polyline
                points="24,62 74,28 122,56 172,22 222,54"
                fill="none"
                stroke="var(--color-accent)"
                strokeOpacity="0.42"
                strokeWidth="1.15"
                strokeDasharray="3 4"
              />
              {[
                { cx: 24, cy: 62, r: 2.3, sym: 'α', dx: -4, dy: 16, delay: '0s' },
                { cx: 74, cy: 28, r: 2.6, sym: 'β', dx: -4, dy: -9, delay: '0.9s' },
                { cx: 122, cy: 56, r: 2.2, sym: 'γ', dx: -3, dy: 16, delay: '1.6s' },
                { cx: 172, cy: 22, r: 2.8, sym: 'δ', dx: -3, dy: -9, delay: '2.4s' },
                { cx: 222, cy: 54, r: 2.3, sym: '', dx: 0, dy: 0, delay: '0.5s' },
              ].map((star, idx) => (
                <g key={idx}>
                  <circle
                    cx={star.cx}
                    cy={star.cy}
                    r={star.r * 3}
                    fill="var(--color-accent)"
                    fillOpacity="0.16"
                    className="celestial-pulse-star"
                    style={{ animationDelay: star.delay }}
                  />
                  <circle cx={star.cx} cy={star.cy} r={star.r} fill="var(--color-accent)" fillOpacity="0.8" />
                  {star.sym && (
                    <text
                      x={star.cx + star.dx}
                      y={star.cy + star.dy}
                      fill="var(--color-ink-muted)"
                      fillOpacity="0.62"
                      fontSize="10"
                      className="tabular-nums-mono"
                    >
                      {star.sym}
                    </text>
                  )}
                </g>
              ))}
            </g>
          </svg>

          {/* Mid-left flank: Topographic mountain ridge elevation profile */}
          <svg
            viewBox="0 0 210 150"
            className="celestial-float-slow absolute top-[42%] left-2 hidden h-[126px] w-[176px] sm:left-6 sm:block"
          >
            <g fill="none">
              <line x1="18" y1="22" x2="18" y2="128" stroke="var(--color-ink)" strokeOpacity="0.28" strokeWidth="1" />
              <path d="M 14 42 L 22 42 M 14 70 L 20 70 M 14 98 L 22 98 M 14 126 L 194 126" stroke="var(--color-ink)" strokeOpacity="0.26" strokeWidth="0.9" />
              <path
                d="M 24 124 L 54 88 L 78 96 L 114 42 L 146 78 L 166 64 L 194 124"
                stroke="var(--color-postmark)"
                strokeOpacity="0.48"
                strokeWidth="1.3"
              />
              <path
                d="M 24 124 L 64 102 L 98 110 L 132 76 L 172 104 L 194 124"
                stroke="var(--color-accent)"
                strokeOpacity="0.32"
                strokeWidth="1"
                strokeDasharray="3 4"
              />
              <circle cx="114" cy="42" r="2.4" fill="var(--color-postmark)" fillOpacity="0.72" />
              <circle cx="166" cy="64" r="2" fill="var(--color-accent)" fillOpacity="0.65" />
              <text x="114" y="31" textAnchor="middle" fill="var(--color-ink-muted)" fillOpacity="0.66" fontSize="9.5" className="tabular-nums-mono">
                4,680m
              </text>
              <text x="168" y="54" textAnchor="middle" fill="var(--color-ink-muted)" fillOpacity="0.56" fontSize="9" className="tabular-nums-mono">
                3,920m
              </text>
            </g>
          </svg>

          {/* Mid-right flank: Equatorial armillary astrolabe & planetary ring dots */}
          <svg
            viewBox="0 0 210 210"
            className="celestial-float-reverse absolute top-[37%] right-2 hidden h-[168px] w-[168px] sm:right-6 sm:block"
          >
            <g fill="none">
              <circle
                cx="105"
                cy="105"
                r="82"
                stroke="var(--color-ink)"
                strokeOpacity="0.28"
                strokeWidth="1"
                strokeDasharray="4 6"
                className="celestial-spin-slow"
                style={{ transformOrigin: '105px 105px' }}
              />
              <circle
                cx="105"
                cy="105"
                r="60"
                stroke="var(--color-accent)"
                strokeOpacity="0.38"
                strokeWidth="1.15"
                strokeDasharray="24 8 4 8"
                className="celestial-spin-reverse"
                style={{ transformOrigin: '105px 105px' }}
              />
              <ellipse
                cx="105"
                cy="105"
                rx="78"
                ry="28"
                transform="rotate(-22 105 105)"
                stroke="var(--color-postmark)"
                strokeOpacity="0.36"
                strokeWidth="1"
              />
              <circle cx="105" cy="105" r="4" fill="var(--color-postmark)" fillOpacity="0.58" />
              <circle cx="163" cy="89" r="2.6" fill="var(--color-accent)" fillOpacity="0.72" />
              <circle cx="62" cy="149" r="2.2" fill="var(--color-postmark)" fillOpacity="0.65" />
              <circle cx="136" cy="54" r="2" fill="var(--color-ink)" fillOpacity="0.55" />
              {variant === 'vault' && (
                <>
                  <circle cx="105" cy="105" r="40" stroke="var(--color-postmark)" strokeOpacity="0.44" strokeDasharray="2 5" />
                  <path d="M105 16 L105 26 M105 184 L105 194 M16 105 L26 105 M184 105 L194 105" stroke="var(--color-ink)" strokeOpacity="0.32" strokeWidth="1" />
                </>
              )}
            </g>
          </svg>

          {/* Top-left: Topographic mountain contour rings & coordinate hairline */}
          <svg
            viewBox="0 0 360 360"
            className="celestial-float-slow absolute -top-6 -left-8 h-[280px] w-[280px] sm:h-[340px] sm:w-[340px]"
            style={{
              transform: 'translate3d(calc(var(--px, 0) * 6px), calc(var(--py, 0) * 4px), 0)',
              transition: 'transform 340ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            <g fill="none" stroke="var(--color-ink)" strokeOpacity="0.3" strokeWidth="1.05">
              <path d="M46 196 C42 126, 98 62, 174 58 C248 54, 294 114, 290 176 C286 244, 224 294, 152 288 C88 282, 50 248, 46 196 Z" />
              <path d="M76 192 C74 142, 114 94, 170 90 C224 86, 258 128, 254 176 C250 226, 206 260, 154 254 C106 248, 78 228, 76 192 Z" />
              <path
                d="M106 186 C106 150, 134 122, 168 120 C204 118, 224 144, 222 174 C220 206, 192 228, 158 224 C128 220, 106 210, 106 186 Z"
                stroke="var(--color-postmark)"
                strokeOpacity="0.52"
              />
              <circle cx="166" cy="172" r="2.8" fill="var(--color-postmark)" fillOpacity="0.74" stroke="none" />
              <text
                x="180"
                y="175"
                fill="var(--color-ink-muted)"
                fillOpacity="0.74"
                stroke="none"
                fontSize="10"
                className="tabular-nums-mono"
              >
                30.06°N · 101.96°E
              </text>
            </g>
          </svg>

          {/* Top-right: Minimal Big Dipper / Cassiopeia constellation or Vault cipher stars */}
          <svg
            viewBox="0 0 420 260"
            className="celestial-float-reverse absolute top-4 right-2 h-[190px] w-[300px] sm:top-6 sm:right-8 sm:h-[230px] sm:w-[370px]"
            style={{
              transform: 'translate3d(calc(var(--px, 0) * -6px), calc(var(--py, 0) * 4px), 0)',
              transition: 'transform 340ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {variant === 'vault' ? (
              <g fill="none" stroke="var(--color-accent)" strokeOpacity="0.48">
                <circle
                  cx="268"
                  cy="128"
                  r="86"
                  strokeDasharray="3 7"
                  className="celestial-spin-slow"
                  style={{ transformOrigin: '268px 128px' }}
                />
                <circle
                  cx="268"
                  cy="128"
                  r="64"
                  stroke="var(--color-postmark)"
                  strokeOpacity="0.5"
                  strokeDasharray="16 6 2 6"
                  className="celestial-spin-reverse"
                  style={{ transformOrigin: '268px 128px' }}
                />
                <path
                  d="M268 34 L268 48 M268 208 L268 222 M174 128 L188 128 M348 128 L362 128"
                  stroke="var(--color-ink)"
                  strokeOpacity="0.38"
                />
              </g>
            ) : (
              <g>
                {/* Great Dipper (Ursa Major) minimal vector trace */}
                <polyline
                  points="52,138 112,116 164,132 214,114 238,162 308,154 326,102 214,114"
                  fill="none"
                  stroke="var(--color-accent)"
                  strokeOpacity="0.45"
                  strokeWidth="1.25"
                  strokeDasharray="3 4"
                />
                {[
                  [52, 138, 2.8, '0s'],
                  [112, 116, 2.4, '0.8s'],
                  [164, 132, 2.6, '1.4s'],
                  [214, 114, 2.2, '2.1s'],
                  [238, 162, 2.4, '0.4s'],
                  [308, 154, 2.7, '1.7s'],
                  [326, 102, 3.0, '2.6s'],
                ].map(([cx, cy, r, delay], idx) => (
                  <g key={idx}>
                    <circle
                      cx={cx}
                      cy={cy}
                      r={Number(r) * 2.8}
                      fill="var(--color-accent)"
                      fillOpacity="0.16"
                      className="celestial-pulse-star"
                      style={{ animationDelay: String(delay) }}
                    />
                    <circle
                      cx={cx}
                      cy={cy}
                      r={r}
                      fill="var(--color-accent)"
                      fillOpacity="0.8"
                    />
                  </g>
                ))}
              </g>
            )}
          </svg>

          {/* Bottom-left: Compass azimuth astrolabe ring or Postmark wax-seal rings */}
          <svg
            viewBox="0 0 320 320"
            className="absolute -bottom-10 -left-8 h-[240px] w-[240px] sm:h-[290px] sm:w-[290px]"
            style={{
              transform:
                'rotate(calc(var(--px, 0) * 7deg + var(--py, 0) * -4deg))',
              transition: 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {variant === 'vault' ? (
              <g fill="none">
                <circle
                  cx="160"
                  cy="160"
                  r="116"
                  stroke="var(--color-postmark)"
                  strokeOpacity="0.38"
                  strokeWidth="1.2"
                  strokeDasharray="6 6"
                  className="celestial-spin-slow"
                  style={{ transformOrigin: '160px 160px' }}
                />
                <circle
                  cx="160"
                  cy="160"
                  r="94"
                  stroke="var(--color-postmark)"
                  strokeOpacity="0.28"
                  strokeWidth="1"
                />
                <circle
                  cx="160"
                  cy="160"
                  r="58"
                  stroke="var(--color-accent)"
                  strokeOpacity="0.34"
                  strokeDasharray="24 8"
                  className="celestial-spin-reverse"
                  style={{ transformOrigin: '160px 160px' }}
                />
                <path
                  d="M92 160 L228 160 M160 92 L160 228"
                  stroke="var(--color-ink)"
                  strokeOpacity="0.18"
                />
              </g>
            ) : (
              <g fill="none">
                <circle
                  cx="160"
                  cy="160"
                  r="118"
                  stroke="var(--color-ink)"
                  strokeOpacity="0.24"
                  strokeDasharray="2 8"
                  className="celestial-spin-slow"
                  style={{ transformOrigin: '160px 160px' }}
                />
                <circle
                  cx="160"
                  cy="160"
                  r="88"
                  stroke="var(--color-accent)"
                  strokeOpacity="0.34"
                  strokeDasharray="42 14 8 14"
                  className="celestial-spin-reverse"
                  style={{ transformOrigin: '160px 160px' }}
                />
                <path
                  d="M160 34 L160 52 M160 268 L160 286 M34 160 L52 160 M268 160 L286 160"
                  stroke="var(--color-postmark)"
                  strokeOpacity="0.52"
                  strokeWidth="1.2"
                />
                <polygon
                  points="160,136 166,160 160,184 154,160"
                  fill="var(--color-postmark)"
                  fillOpacity="0.32"
                />
              </g>
            )}
          </svg>

          {/* Lower-center-left: Minimal darkroom lens aperture & focal length scale */}
          <svg
            viewBox="0 0 240 66"
            className="celestial-float-slow absolute bottom-8 left-[22%] hidden h-[58px] w-[220px] lg:block"
          >
            <g fill="none">
              <circle cx="34" cy="30" r="19" stroke="var(--color-ink)" strokeOpacity="0.28" strokeWidth="1" />
              <circle cx="34" cy="30" r="11" stroke="var(--color-accent)" strokeOpacity="0.38" strokeWidth="1" strokeDasharray="3 3" />
              <path d="M25 18 L43 24 M45 21 L38 40 M23 39 L31 20" stroke="var(--color-ink)" strokeOpacity="0.22" strokeWidth="0.85" />
              <line x1="68" y1="30" x2="226" y2="30" stroke="var(--color-ink)" strokeOpacity="0.2" strokeWidth="0.9" />
              {[80, 124, 168, 212].map((x) => (
                <line key={x} x1={x} y1="25" x2={x} y2="34" stroke="var(--color-postmark)" strokeOpacity="0.45" strokeWidth="1" />
              ))}
              <text x="148" y="50" textAnchor="middle" fill="var(--color-ink-muted)" fillOpacity="0.6" fontSize="9.5" className="tabular-nums-mono">
                24mm · 35mm · 50mm · 85mm
              </text>
            </g>
          </svg>

          {/* Lower-center-right: Geodesic compass rose & travel coordinate stamp */}
          <svg
            viewBox="0 0 230 74"
            className="celestial-float-reverse absolute right-[22%] bottom-8 hidden h-[64px] w-[205px] lg:block"
          >
            <g fill="none">
              <circle cx="188" cy="34" r="22" stroke="var(--color-postmark)" strokeOpacity="0.34" strokeWidth="1" strokeDasharray="3 4" />
              <polygon points="188,15 192,34 188,53 184,34" stroke="var(--color-postmark)" strokeOpacity="0.5" strokeWidth="0.95" />
              <line x1="162" y1="34" x2="214" y2="34" stroke="var(--color-ink)" strokeOpacity="0.24" strokeWidth="0.9" />
              <rect x="14" y="22" width="136" height="24" rx="12" stroke="var(--color-ink)" strokeOpacity="0.22" strokeDasharray="4 4" />
              <text x="82" y="37.5" textAnchor="middle" fill="var(--color-ink-muted)" fillOpacity="0.62" fontSize="9.5" className="tabular-nums-mono">
                29.65°N · 94.36°E
              </text>
            </g>
          </svg>

          {/* Bottom-right: Camera darkroom aperture & great-circle flight arc */}
          <svg
            viewBox="0 0 380 280"
            className="celestial-float-slow absolute right-0 bottom-0 h-[210px] w-[285px] sm:right-6 sm:bottom-4 sm:h-[250px] sm:w-[340px]"
            style={{
              transform: 'translate3d(calc(var(--px, 0) * -5px), calc(var(--py, 0) * -5px), 0)',
              transition: 'transform 340ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {variant === 'vault' ? (
              <g fill="none" stroke="var(--color-ink)" strokeOpacity="0.24">
                <rect x="116" y="72" width="196" height="132" rx="18" strokeDasharray="5 5" />
                <path d="M132 94 L152 94 M132 94 L132 114 M296 94 L276 94 M296 94 L296 114 M132 182 L152 182 M132 182 L132 162 M296 182 L276 182 M296 182 L296 162" stroke="var(--color-accent)" strokeOpacity="0.44" strokeWidth="1.25" />
                <line x1="146" y1="126" x2="244" y2="126" strokeOpacity="0.28" />
                <line x1="146" y1="146" x2="218" y2="146" stroke="var(--color-postmark)" strokeOpacity="0.42" />
              </g>
            ) : (
              <g fill="none">
                {/* Sweeping dashed journey route arc */}
                <path
                  d="M 28 228 Q 168 92 332 142"
                  stroke="var(--color-postmark)"
                  strokeOpacity="0.38"
                  strokeWidth="1.25"
                  strokeDasharray="5 7"
                  className="celestial-dash-drift"
                />
                <circle cx="28" cy="228" r="3.2" fill="var(--color-postmark)" fillOpacity="0.54" />
                <circle cx="332" cy="142" r="3.8" fill="var(--color-accent)" fillOpacity="0.62" />

                {/* Darkroom optical viewfinder & diaphragm ring */}
                <g
                  className="celestial-spin-slow"
                  style={{ transformOrigin: '250px 180px' }}
                  stroke="var(--color-ink)"
                  strokeOpacity="0.26"
                >
                  <circle cx="250" cy="180" r="54" strokeDasharray="12 6" />
                  <circle cx="250" cy="180" r="32" stroke="var(--color-accent)" strokeOpacity="0.32" />
                </g>
                <path
                  d="M174 128 L192 128 M174 128 L174 146 M326 128 L308 128 M326 128 L326 146 M174 232 L192 232 M174 232 L174 214 M326 232 L308 232 M326 232 L326 214"
                  stroke="var(--color-ink)"
                  strokeOpacity="0.28"
                  strokeWidth="1.2"
                />
              </g>
            )}
          </svg>
        </div>
      )}

      {/* Layer 3: Cursor lantern spotlight illuminating finer cartographic contours near pointer */}
      <div
        className="celestial-lantern-layer absolute inset-0"
        style={{
          WebkitMaskImage:
            'radial-gradient(270px circle at var(--lantern-x, -999px) var(--lantern-y, -999px), rgba(0,0,0,1) 0%, rgba(0,0,0,0.45) 48%, rgba(0,0,0,0) 78%)',
          maskImage:
            'radial-gradient(270px circle at var(--lantern-x, -999px) var(--lantern-y, -999px), rgba(0,0,0,1) 0%, rgba(0,0,0,0.45) 48%, rgba(0,0,0,0) 78%)',
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(240px circle at var(--lantern-x, -999px) var(--lantern-y, -999px), color-mix(in srgb, var(--color-accent) 13%, transparent) 0%, color-mix(in srgb, var(--color-postmark) 7%, transparent) 45%, transparent 75%)',
          }}
        />
        <svg className="h-full w-full" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id={finePatternId} width="112" height="112" patternUnits="userSpaceOnUse">
              <path
                d="M 112 0 L 0 0 0 112"
                fill="none"
                stroke="var(--color-accent)"
                strokeOpacity="0.24"
                strokeWidth="1"
              />
              <path
                d="M 56 0 L 56 112 M 0 56 L 112 56"
                fill="none"
                stroke="var(--color-postmark)"
                strokeOpacity="0.14"
                strokeWidth="0.75"
                strokeDasharray="2 6"
              />
              <circle cx="0" cy="0" r="2" fill="var(--color-accent)" fillOpacity="0.48" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${finePatternId})`} />
        </svg>
      </div>
    </div>
  );
}
