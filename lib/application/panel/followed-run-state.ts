/** State for a panel that follows another tab's live run. */
export class FollowedRunState {
  followedRunState: any = null;
  followedRunId = '';
  followedCursor = 0;
  /** 连续多少次轮询没有新 cursor：用来发现“run 已死但状态仍标 running”。 */
  followedIdleTicks = 0;
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
