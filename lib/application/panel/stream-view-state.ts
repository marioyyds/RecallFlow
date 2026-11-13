/** Mutable DOM handles and presentation toggles for the live stream. */
export class StreamViewState {
  pendingAiMsg: any = null;
  pendingContentEl: any = null;
  flowEl: any = null;
  typingEl: any = null;
  thinkSeg: any = null;
  thinkSegSeq = 0;
  thinkExpandedManual: any = null;
  planBar: any = null;
  apiKeyBanner: any = null;
  approvalSettingsEl: any = null;
  approvalPopoverEl: any = null;
  lastPlan: any[] = [];
  /** 上一次真正画进计划条的指纹：没变就不再重建 DOM（见 chat.ts 的 renderPlan）。 */
  lastPlanSig = '';
  planExpanded: any = null;
  planWasAllDone = false;
  usageEl: any = null;
  currentCitations: any = null;
  pickedElements: any[] = [];
  pickUi: any = null;
  picking = false;
  pageContextEnabled = true;
  citeHighlightEntered = false;
}
