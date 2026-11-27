import type { PointerEvent as ReactPointerEvent } from 'react';

function supportsFineMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return (
    window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
    window.matchMedia('(prefers-reduced-motion: no-preference)').matches
  );
}

/** Pointer spotlight & subtle +/-1.8deg perspective tilt handlers for editorial cards. */
export function createCardPointerHandlers() {
  return {
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (!supportsFineMotion()) return;
      const el = event.currentTarget;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const nx = (x / rect.width) * 2 - 1;
      const ny = (y / rect.height) * 2 - 1;

      el.style.setProperty('--mx', `${x.toFixed(1)}px`);
      el.style.setProperty('--my', `${y.toFixed(1)}px`);
      el.style.setProperty('--tilt-x', `${(-ny * 1.6).toFixed(2)}deg`);
      el.style.setProperty('--tilt-y', `${(nx * 1.6).toFixed(2)}deg`);
    },
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
      const el = event.currentTarget;
      el.style.setProperty('--tilt-x', '0deg');
      el.style.setProperty('--tilt-y', '0deg');
    },
  };
}

/** Subtle magnetic translation (+/-4px max) for capsule CTA controls. */
export function createMagneticHandlers(maxPx = 4) {
  return {
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (!supportsFineMotion()) return;
      const el = event.currentTarget;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const nx = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
      const ny = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1));
      el.style.setProperty('--mag-x', `${(nx * maxPx).toFixed(2)}px`);
      el.style.setProperty('--mag-y', `${(ny * maxPx).toFixed(2)}px`);
    },
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
      const el = event.currentTarget;
      el.style.setProperty('--mag-x', '0px');
      el.style.setProperty('--mag-y', '0px');
    },
  };
}
