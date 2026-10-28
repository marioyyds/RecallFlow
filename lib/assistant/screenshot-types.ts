import * as cdp from '../backend/cdp.ts';
import type { RunCtx } from './types.ts';
import type { screenshotAttempts } from '../shared/utils.ts';
import type { saveScreenshot } from '../shared/screenshot-store.ts';

export interface ScreenshotDeps {
  ctx: RunCtx;
  args: Record<string, unknown>;
  cdp: typeof cdp;
  cdpAllowed: (ctx: RunCtx | null | undefined) => boolean;
  screenshotAttempts: typeof screenshotAttempts;
  saveScreenshot: typeof saveScreenshot;
  chrome: typeof chrome;
  formatScreenshotSummary: (meta: unknown, visionEnabled?: unknown) => string;
  screenshotBudgetMs?: number;
}

export interface ScreenshotLadderStep {
  format: string;
  quality?: number;
}

export interface ScreenshotLadderInput {
  cdp: typeof cdp;
  tabId: number;
  ladder: ScreenshotLadderStep[];
  budgetMs: number;
  fullPage: boolean;
}

export interface ScreenshotLadderResult {
  data: string;
  used: ScreenshotLadderStep;
  usedIndex: number;
  degraded: boolean;
  timedOut: boolean;
  deadline: number;
}
