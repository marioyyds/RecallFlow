// Pure projection of local/followed run state onto composer controls.
// 「当前该把发送/停止按钮画成什么样」—— 纯函数，不碰 DOM。
//
// 单独抽出来是因为这条判断的两个输入（本页是否在流式输出、跟随的那个 run 是什么状态）
// 来自两条完全不同的通道，而它们的组合**只有四种情况里有三种是错的**：
// 跟随页在跑时若漏掉显示停止按钮，用户就只能眼睁睁看着一个停不下来的任务；
// 运行中若忘记禁掉发送，用户会往同一个会话里塞第二条指令。
// 这些错了都不会报错，只会「用起来怪」。导出以便直测。
export function computeRunControls(input: any) {
  const src = input || {};
  const followingRunning = Boolean(src.followed && src.followed.status === 'running');
  const running = Boolean(src.streaming || followingRunning);
  // 只有跟随的 run 会带 stopping 标记：本页自己在跑时，停止请求由流的中断来体现。
  const stopping = Boolean(followingRunning && src.followed.stopping);
  return {
    showStop: running,
    // 停止中必须**禁点**：否则用户连点几次，会把同一个中断请求反复发出去。
    stopDisabled: stopping,
    stopText: stopping ? '停止中…' : '■ 停止',
    sendDisabled: running,
  };
}
