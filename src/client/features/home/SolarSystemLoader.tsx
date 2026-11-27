import { useEffect, useRef, useState } from 'react';
import { canTransitionDisplay } from '../../lib/top-layer';

type SolarSystemLoaderProps = {
  ready: boolean;
};

/** Theme-authentic astronomical Solar System Orrery loader covering lazy chunk + WebGL init. */
export default function SolarSystemLoader({ ready }: SolarSystemLoaderProps) {
  const [unmounted, setUnmounted] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ready) return;
    const el = overlayRef.current;
    if (!el) {
      setUnmounted(true);
      return;
    }

    let cancelled = false;

    const finishExit = async () => {
      if (canTransitionDisplay()) {
        el.hidden = true;
      } else {
        el.setAttribute('data-closing', '');
      }

      const animations = typeof el.getAnimations === 'function' ? el.getAnimations() : [];
      if (animations.length > 0) {
        await Promise.race([
          Promise.allSettled(animations.map((a) => a.finished)),
          new Promise<void>((resolve) => {
            window.setTimeout(resolve, 320);
          }),
        ]);
      }

      if (cancelled) return;
      if (el.hasAttribute('data-closing')) {
        el.removeAttribute('data-closing');
        el.hidden = true;
      }
      setUnmounted(true);
    };

    void finishExit();

    return () => {
      cancelled = true;
    };
  }, [ready]);

  if (unmounted) return null;

  return (
    <div
      ref={overlayRef}
      role="status"
      aria-live="polite"
      aria-busy={!ready}
      data-testid="solar-system-loader"
      className={`solar-loader-overlay absolute inset-x-0 bottom-0 -top-[var(--nav-height)] z-[15] flex flex-col items-center justify-center overflow-hidden bg-deep-space ${ready ? 'pointer-events-none' : ''}`}
    >
      {/* Subtle solar-wind ambient backdrop glow & horizontal ecliptic guide hairline */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 46%, rgba(255, 186, 92, 0.14) 0%, rgba(138, 180, 248, 0.045) 34%, rgba(11, 12, 14, 0) 64%)',
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-[46%] left-1/2 h-px w-[min(72vw,480px)] -translate-x-1/2 -translate-y-1/2"
        style={{
          background:
            'linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 214, 148, 0.2) 50%, rgba(255, 255, 255, 0) 100%)',
        }}
      />

      {/* Centerpiece Astronomical Solar Orrery */}
      <div className="relative flex h-[176px] w-[176px] -translate-y-[18px] items-center justify-center">
        {/* Precision astrolabe concentric orbit hairlines & cardinal ticks */}
        <svg
          viewBox="0 0 176 176"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <circle cx="88" cy="88" r="51" fill="none" stroke="rgba(255, 255, 255, 0.09)" strokeWidth="1" />
          <circle cx="88" cy="88" r="69" fill="none" stroke="rgba(255, 255, 255, 0.09)" strokeWidth="1" />
          <circle cx="88" cy="88" r="87" fill="none" stroke="rgba(255, 255, 255, 0.09)" strokeWidth="1" />
          <line x1="88" y1="0" x2="88" y2="5" stroke="rgba(255, 255, 255, 0.22)" strokeWidth="1" />
          <line x1="88" y1="171" x2="88" y2="176" stroke="rgba(255, 255, 255, 0.22)" strokeWidth="1" />
          <line x1="0" y1="88" x2="5" y2="88" stroke="rgba(255, 255, 255, 0.22)" strokeWidth="1" />
          <line x1="171" y1="88" x2="176" y2="88" stroke="rgba(255, 255, 255, 0.22)" strokeWidth="1" />
        </svg>

        {/* Semantic native indeterminate progress ring styled via conic-gradient & mask/border-area */}
        <progress
          aria-label="正在校准太阳系星轨"
          className="solar-loader-progress absolute"
        />

        {/* Soft breathing solar corona halo & incandescent sun core */}
        <div
          aria-hidden="true"
          className="solar-core-glow pointer-events-none absolute h-11 w-11 rounded-full"
          style={{
            background:
              'radial-gradient(circle, rgba(255, 214, 128, 0.48) 0%, rgba(235, 134, 42, 0.16) 54%, rgba(235, 134, 42, 0) 76%)',
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none relative h-5 w-5 rounded-full shadow-[0_0_20px_rgba(255,190,94,0.75)]"
          style={{
            background: 'radial-gradient(circle at 38% 36%, #fff8dc 0%, #ffd269 48%, #e68224 100%)',
          }}
        />

        {/* Orbiting Earth carrier (initial phase -35deg) */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute h-[102px] w-[102px] rotate-[-35deg]"
        >
          <div className="solar-orbit-earth relative h-full w-full">
            <span
              className="absolute top-0 left-1/2 block h-[5.5px] w-[5.5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#6cb2ff]"
              style={{ boxShadow: '0 0 8px rgba(108, 178, 255, 0.85)' }}
            />
          </div>
        </div>

        {/* Orbiting Jupiter carrier (initial phase 115deg) */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute h-[138px] w-[138px] rotate-[115deg]"
        >
          <div className="solar-orbit-jupiter relative h-full w-full">
            <span
              className="absolute top-0 left-1/2 block h-[7.5px] w-[7.5px] -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                background: 'linear-gradient(180deg, #ead7b7 0%, #c88d59 55%, #e6cea7 100%)',
                boxShadow: '0 0 8px rgba(218, 162, 108, 0.5)',
              }}
            />
          </div>
        </div>

        {/* Orbiting Saturn carrier with elliptical ring (initial phase 230deg) */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute h-[174px] w-[174px] rotate-[230deg]"
        >
          <div className="solar-orbit-saturn relative h-full w-full">
            <span className="absolute top-0 left-1/2 flex h-[10px] w-[18px] -translate-x-1/2 -translate-y-1/2 items-center justify-center">
              <span
                className="block h-[6.5px] w-[6.5px] rounded-full bg-[#e5cf9f]"
                style={{ boxShadow: '0 0 6px rgba(229, 207, 159, 0.55)' }}
              />
              <span
                className="pointer-events-none absolute h-[5px] w-[16px] -rotate-[18deg] rounded-full border border-[#e5cf9f]/70"
              />
            </span>
          </div>
        </div>
      </div>

      {/* Quiet observatory status caption */}
      <div className="mt-3 flex flex-col items-center gap-1.5 text-center">
        <span className="tabular-nums-mono text-[10.5px] tracking-[0.18em] text-white/42 uppercase">
          EPHEMERIS · J2000
        </span>
        <span className="text-[12.5px] tracking-[0.06em] text-white/70">
          正在校准太阳系星轨
        </span>
      </div>
    </div>
  );
}
