export type HandoffTarget = 'image' | 'grade';

export interface ToolkitMediaHandoff {
  target: HandoffTarget;
  blob: Blob;
  fileName: string;
  sourceLabel: string;
  place?: string;
  caption?: string;
  takenAt?: string | null;
  exifSummary?: string;
  createdAt: number;
}

const handoffStore: Record<HandoffTarget, ToolkitMediaHandoff | null> = {
  image: null,
  grade: null,
};

/**
 * Store a local in-memory media handoff between Mercury Toolkit instruments
 * (e.g. Log Video frame grab -> Photo Grade -> Image Darkroom framing).
 * Zero network I/O and zero localStorage bloat.
 */
export function setToolkitHandoff(item: ToolkitMediaHandoff): void {
  handoffStore[item.target] = item;
}

/**
 * Read and immediately clear the pending handoff for a target tool.
 */
export function consumeToolkitHandoff(target: HandoffTarget): ToolkitMediaHandoff | null {
  const item = handoffStore[target];
  handoffStore[target] = null;
  return item;
}

/**
 * Non-destructively inspect the pending handoff for a target tool.
 */
export function peekToolkitHandoff(target: HandoffTarget): ToolkitMediaHandoff | null {
  return handoffStore[target];
}

/**
 * Clear a single target or all pending handoffs.
 */
export function clearToolkitHandoff(target?: HandoffTarget): void {
  if (target) {
    handoffStore[target] = null;
    return;
  }
  handoffStore.image = null;
  handoffStore.grade = null;
}
