export interface PanelWheelEventLike {
  ctrlKey?: boolean;
  metaKey?: boolean;
  deltaY?: number;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export interface PanelWheelDecision {
  /** Ctrl/Meta-wheel and trackpad pinch must not change the host page zoom. */
  blockPageZoom: boolean;
  /** Non-zoom wheel keeps native scrolling and only stops host-page handlers. */
  allowNativeScroll: boolean;
  scrollUp: boolean;
}

export function panelWheelDecision(event: PanelWheelEventLike): PanelWheelDecision {
  const blockPageZoom = Boolean(event.ctrlKey || event.metaKey);
  return {
    blockPageZoom,
    allowNativeScroll: !blockPageZoom,
    scrollUp: Number(event.deltaY) < 0,
  };
}

type WheelTargetLike = {
  addEventListener: (
    type: string,
    listener: (event: PanelWheelEventLike) => void,
    options?: { passive?: boolean }
  ) => void;
};

function applyPanelWheel(event: PanelWheelEventLike): PanelWheelDecision {
  const decision = panelWheelDecision(event);
  if (typeof event.stopPropagation === 'function') event.stopPropagation();
  if (decision.blockPageZoom && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }
  return decision;
}

/** Block host-page wheel handlers and page zoom for the whole floating panel. */
export function bindPanelWheelGuard(target: WheelTargetLike): void {
  target.addEventListener('wheel', applyPanelWheel, { passive: false });
}

/** Guard the conversation scroller and report genuine user scroll intent. */
export function bindPanelWheelScroller(
  target: WheelTargetLike,
  markUserScrollIntent: (scrollUp: boolean) => void
): void {
  target.addEventListener('wheel', (event) => {
    const decision = applyPanelWheel(event);
    markUserScrollIntent(decision.scrollUp);
  }, { passive: false });
}
