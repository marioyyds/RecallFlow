/** State for a panel that follows another tab's live run. */
export class FollowedRunState {
  followedRunState: any = null;
  followedRunId = '';
  followedCursor = 0;
  /** 连续多少次轮询没有新 cursor：用来发现“run 已死但状态仍标 running”。 */
  followedIdleTicks = 0;
  /**
   * 已经"跟随 → 收尾落盘"过的 runId。
   *
   * 为什么必须记住它：那个 run 在 SW 里可能还会被订阅/广播返回（快照仍标 running，
   * 但包里已经没有任何新内容）。若每次都重新跟随、再判"已落盘"、再撤层强制重建，
   * 就形成**自激活循环** —— 实测 19 秒内整段正文重建 58 次（11,592px 的对话，
   * 每次全量 innerHTML + 强制布局），表现正是「卡顿 / 白屏」。
   * 同一个 runId 只允许收尾一次；新 run 到来（runId 变了）时才清空。
   */
  settledRunId = '';
  followedMessages: any[] = [];
  followedLiveReady = false;
  followedDom: any = null;
  followRefreshTimer: any = null;
  followStatusTimer: any = null;
  observerAutoScroll = true;

  reset(): void {
    this.followedRunState = null;
    this.followedRunId = '';
    this.followedCursor = 0;
    this.followedIdleTicks = 0;
    this.followedMessages = [];
    this.followedLiveReady = false;
    this.followedDom = null;
    if (this.followRefreshTimer) clearTimeout(this.followRefreshTimer);
    this.followRefreshTimer = null;
    if (this.followStatusTimer) clearTimeout(this.followStatusTimer);
    this.followStatusTimer = null;
    this.observerAutoScroll = true;
  }
}
