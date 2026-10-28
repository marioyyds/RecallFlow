// 工具族依赖（DI）接口（Batch 6b-1）
//
// 每个 handler 族一个接口，字段**只包含该族真正用到的依赖**（最小形状）。
// 这样 `tools.ts` 里注册时传入的对象会被结构化检查：
//   · 漏传一个字段 → tsc 报错（此前 `deps: any` 会把"漏传"变成运行期的 undefined 调用）；
//   · 多传一个字段 → 也不会被悄悄用到（族与族之间的耦合边界变得可见）。
//
// 借用已导出函数的签名一律用 `typeof fn`，避免把签名抄第二份（抄写漂移是 L-42 的同类风险）。
import * as cdp from '../../backend/cdp.ts';
import { getTrace, listTraces } from './trace.ts';
import { handleDialog, getDownloads } from './target-manager.ts';
import { readBounded, decodeBuffer, extractHtmlTitle, searchWeb, isAbortLikeError, describeFetchError } from './net-parse.ts';
import { listScripts as listUserscripts, searchScripts, installFromUrl, runUserscriptOnTab } from '../../userscript/manager.ts';
import { getUserscriptSettings } from '../../userscript/settings.ts';
import { typeInfo } from '../../shared/dom/html.ts';
import { trimElementsToBudget, formatVisibilityReport, formatCurrentPageResult } from '../../shared/format/page-results.ts';
import { formatScreenshotSummary } from '../../shared/vision-copy.ts';
import { getBook, upsertItem, deleteItem } from '../../shared/store.ts';
import { buildRagContext, buildCitations, type KnowledgeBook } from '../../shared/rag.ts';
import { sliceSafe } from '../../shared/surrogates.ts';
import type { RunCtx, PageSnapshotLike, ToolResult, ActionVerification, MacroRecord, RecalledTrace, TraceStep, SkillLike } from './types.ts';
import type { Caught } from './errors.ts';
import type {
  ScreenshotDeps,
  ScreenshotLadderInput,
  ScreenshotLadderResult,
  ScreenshotLadderStep,
} from './screenshot-types.ts';

export type {
  ScreenshotDeps,
  ScreenshotLadderInput,
  ScreenshotLadderResult,
  ScreenshotLadderStep,
} from './screenshot-types.ts';

/** 页面元素解析结果（`kbResolveTarget` 的 found 回执）。 */
export interface ResolvedTarget extends ToolResult {
  selector: string;
  rect: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    centerX: number;
    centerY: number;
  };
}

/** 向标签页（可指定 frameId）发消息；内容脚本不可达时由桥接层补注入重试。 */
export type SendTabMessage = (tabId: number, message: unknown, frameId?: number | null) => Promise<ToolResult>;

/** 读取页面快照（内容脚本回执的 version 字段是"可用"判据）。 */
export type GetPageSnapshot = (tabId: number, options?: Record<string, unknown>) => Promise<PageSnapshotLike | null>;

/** 执行页面动作（含前后快照验证）。 */
export type ExecutePageTool = (
  tabId: number,
  command: string,
  args: Record<string, unknown>,
  ctx: RunCtx
) => Promise<ToolResult>;

/** 通过内容脚本执行一次带验证的动作。 */
export type ExecuteContentAction = (
  tabId: number,
  action: string,
  message: Record<string, unknown> | undefined,
  options?: { verify?: boolean; frameId?: number; delayMs?: number }
) => Promise<ToolResult>;

/** 把目标元素解析为「唯一选择器 + 绝对视口坐标」。 */
export type ResolveTarget = (
  tabId: number,
  params: Record<string, unknown> | undefined
) => Promise<ResolvedTarget | null>;

/** CDP（chrome.debugger）是否可用于本次任务。 */
export type CdpAllowed = (ctx: RunCtx | null | undefined) => boolean;

/** 页面读取族（read_current_page / get_page_snapshot / list_frames）。 */
export interface PageReadDeps {
  ctx: RunCtx;
  chrome: typeof chrome;
  cdpAllowed: CdpAllowed;
  sendTabMessage: SendTabMessage;
  getPageSnapshot: GetPageSnapshot;
  getPendingDialogs: typeof import('./target-manager.ts').getPendingDialogs;
  trimElementsToBudget: typeof trimElementsToBudget;
  formatVisibilityReport: typeof formatVisibilityReport;
  formatCurrentPageResult: typeof formatCurrentPageResult;
  splitIntoChunks: (text: string, size: number, max: number) => string[];
  citationTitleFor: (pageTitle: unknown, url: string) => string;
}

/** 页面输入命令族（type_text / press_key / select_option / check_box / wait_for_element / get_attribute）。 */
export interface PageInputDeps {
  ctx: RunCtx;
  cdp: typeof cdp;
  cdpAllowed: CdpAllowed;
  executeContentAction: ExecuteContentAction;
  frameIdFromArgs: (args: Record<string, unknown>) => number | null;
  resolveTarget: ResolveTarget;
  rememberTarget: (ctx: RunCtx, target: ResolvedTarget) => void;
  getPageSnapshot: GetPageSnapshot;
  observedChange: (before: PageSnapshotLike | null, after: PageSnapshotLike | null) => string;
  buildActionVerification: (observed: string, reason: string) => ActionVerification;
  compactSnapshotSummary: (snapshot: PageSnapshotLike | null | undefined) => string;
  summarizeCdpError: (e: Caught | null | undefined) => string;
}

/** CDP 输入族（click_element / click_at / hover_element / drag_element / upload_file）。 */
export interface CdpInputDeps {
  ctx: RunCtx;
  cdp: typeof cdp;
  cdpAllowed: CdpAllowed;
  executePageTool: ExecutePageTool;
  frameIdFromArgs: (args: Record<string, unknown>) => number | null;
  resolveTarget: ResolveTarget;
  rememberTarget: (ctx: RunCtx, target: ResolvedTarget) => void;
  getPageSnapshot: GetPageSnapshot;
  observedChange: (before: PageSnapshotLike | null, after: PageSnapshotLike | null) => string;
  buildActionVerification: (observed: string, reason: string) => ActionVerification;
  compactSnapshotSummary: (snapshot: PageSnapshotLike | null | undefined) => string;
  summarizeCdpError: (e: Caught | null | undefined) => string;
}

/** 页面内代码与结构访问族（run_javascript / get_ax_snapshot）。 */
export interface CodeAccessDeps {
  ctx: RunCtx;
  cdp: typeof cdp;
  cdpAllowed: CdpAllowed;
  executeContentAction: ExecuteContentAction;
  evaluateInPageWorld: (ctx: RunCtx, args: Record<string, unknown>) => Promise<ToolResult>;
  isCspEvalBlockError: (e: unknown) => boolean;
  summarizeCdpError: (e: Caught | null | undefined) => string;
}

/** 权限 / 会话状态族（trust_site / handle_dialog）。 */
export interface PermissionDeps {
  ctx: RunCtx;
  cdpAllowed: CdpAllowed;
  chrome: typeof chrome;
  handleDialog: typeof handleDialog;
  summarizeCdpError: (e: Caught | null | undefined) => string;
}

/** 运行状态族（update_plan / expand_result / get_run_trace）。 */
export interface RunStateDeps {
  ctx: RunCtx;
  getTrace: typeof getTrace;
  listTraces: typeof listTraces;
}

/** 联网抓取与搜索族（fetch_webpage / web_search）。 */
export interface FetchDeps {
  ctx: RunCtx;
  fetchImpl: typeof fetch;
  readBounded: typeof readBounded;
  decodeBuffer: typeof decodeBuffer;
  stripHtml: (html: string) => string;
  extractHtmlTitle: typeof extractHtmlTitle;
  searchWeb: typeof searchWeb;
  isAbortLikeError: typeof isAbortLikeError;
  describeFetchError: typeof describeFetchError;
}

/** 页面命令（内容脚本）族（annotate / inspect_element / scroll_page / get_element_source / undo_last_action）。 */
export interface PageCommandDeps {
  ctx: RunCtx;
  toolError: (code: string, message: string, extra?: Record<string, unknown>) => ToolResult;
  executePageTool: ExecutePageTool;
  executeContentAction: ExecuteContentAction;
  sendTabMessage: SendTabMessage;
}

/** 标签页族（list_tabs / switch_tab / open_tab）。 */
export interface TabDeps {
  chrome: typeof chrome;
  ctx: RunCtx;
  waitForTabReady: (tabId: number, timeoutMs?: number) => Promise<PageSnapshotLike | null>;
  bindSessionTab: (tabId: number) => Promise<void>;
  listOpenedTabsSummary: (ctx: RunCtx) => Promise<string>;
  trackOpenedTab: (ctx: RunCtx, tabId: number) => void;
  ensureAgentWindow: (ctx: RunCtx) => Promise<number>;
}

/** 用户脚本族（list / search / install / run）。 */
export interface UserscriptDeps {
  ctx: RunCtx;
  listUserscripts: typeof listUserscripts;
  searchScripts: typeof searchScripts;
  installFromUrl: typeof installFromUrl;
  runUserscriptOnTab: typeof runUserscriptOnTab;
  getUserscriptSettings: typeof getUserscriptSettings;
}

/** 技能族（load_skill / install_skill / save_skill）。 */
export interface SkillDeps {
  getMergedSkills: () => Promise<SkillLike[]>;
  getUserSkills: () => Promise<SkillLike[]>;
  getDefaultSkills: () => SkillLike[];
  addUserSkill: (skill: SkillLike) => Promise<SkillLike | null>;
  updateUserSkill: (id: string, patch: Partial<SkillLike>) => Promise<SkillLike | null>;
  validateSkillTools: (skill: { tools?: unknown; x?: { tools?: unknown } } | null | undefined) => string[];
  installSkillFromSkillHub: (identifier: string) => Promise<ToolResult>;
}

/** 知识库只读族（knowledge_read）。 */
export interface KnowledgeDeps {
  book: KnowledgeBook;
  buildRagContext: typeof buildRagContext;
  buildCitations: typeof buildCitations;
  typeInfo: typeof typeInfo;
  starLevels: Record<string | number, { name: string; color?: string }>;
}

/** 知识库存储族（knowledge_read / add_entry / remove_entry）。 */
export interface KnowledgeStoreDeps {
  ctx: RunCtx;
  knowledgeRead: (deps: KnowledgeDeps, args: Record<string, unknown>) => ToolResult;
  upsertItem: typeof upsertItem;
  deleteItem: typeof deleteItem;
  getBook: typeof getBook;
  buildRagContext: typeof buildRagContext;
  buildCitations: typeof buildCitations;
  typeInfo: typeof typeInfo;
  STAR_LEVELS: Record<string | number, { name: string; color?: string }>;
  STATUS: Record<string, number>;
}

/** 宏族（macro({op})）。 */
export interface MacroDeps {
  ctx: RunCtx;
  bumpMacroHits: (url: string, name: string) => Promise<unknown>;
  executeTool: (name: string, args: Record<string, unknown>, ctx: RunCtx) => Promise<ToolResult | null>;
  getMacro: (url: string, name: string) => Promise<MacroRecord | null>;
  listMacros: (url: string) => Promise<MacroRecord[]>;
  pageUrl: string;
  recallTrace: (url: string) => Promise<RecalledTrace | null>;
  saveMacro: (url: string, macro: unknown) => Promise<MacroRecord | null>;
  trace: TraceStep[];
  validateToolCall: (name: string, args: Record<string, unknown>) => { ok?: boolean; error?: string };
}

/** 诊断族（read_diagnostics）。 */
export interface DiagnosticsDeps {
  sendTabMessage: SendTabMessage;
  tabId: number;
  getDownloads: typeof getDownloads;
}

export type { RunCtx, PageSnapshotLike, ToolResult, ActionVerification };
