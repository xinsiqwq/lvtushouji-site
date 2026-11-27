let supportsDisplayTransition: boolean | undefined;

/** Runtime probe detecting genuine discrete `display` transition support (handles Firefox bug 1882408). */
export function canTransitionDisplay(): boolean {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (
    typeof window === 'undefined' ||
    !window.CSS?.supports?.('transition-behavior', 'allow-discrete') ||
    !document.body
  ) {
    return false;
  }
  const probe = document.createElement('div');
  // Shorthand intentionally tests whether browser keeps display:block during discrete transition.
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransition = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransition;
}

/** True when both top-layer `overlay` transitions and discrete `display` exit animations work natively. */
export function supportsTopLayerExit(): boolean {
  return Boolean(
    typeof window !== 'undefined' &&
      window.CSS?.supports?.('overlay', 'auto') &&
      canTransitionDisplay(),
  );
}

/** Close a popover while running CSS exit transitions cleanly even where top-layer `overlay` is unsupported. */
export async function closePopoverGracefully(el: HTMLElement | null): Promise<void> {
  if (!el) return;
  let isOpen = false;
  try {
    isOpen = el.matches(':popover-open') || el.classList.contains(':popover-open');
  } catch {
    isOpen = el.classList.contains(':popover-open');
  }
  if (!isOpen) return;

  if (!supportsTopLayerExit()) {
    el.setAttribute('data-closing', '');
    const animations =
      typeof el.getAnimations === 'function' ? el.getAnimations({ subtree: true }) : [];
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, 320);
        }),
      ]);
    }
    if (!el.hasAttribute('data-closing')) return;
    el.removeAttribute('data-closing');
  }

  if (typeof (el as HTMLElement & { hidePopover?: () => void }).hidePopover === 'function') {
    (el as HTMLElement & { hidePopover: () => void }).hidePopover();
  }
}
