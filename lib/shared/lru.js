// 容量受限的 LRU 缓存。
//
// 起因是一处真实的无界增长：面板把每张截图的 base64 dataURL 放进一个模块级 Map，
// 只写入、从不删除。内容脚本的生命周期等于页面生命周期，于是长时间浏览器自动化
// 会话里内存只涨不落 —— 而单张截图就是几百 KB。
//
// 为什么不用「简单的 FIFO 淘汰」：截图是给用户看的，正在看的那张被淘汰掉会显示成
// 「已失效」，而它恰恰是最可能被反复读取的那张。真正需要的是 LRU（读过的算最近使用）。
//
// get() 会改变顺序，这一点是刻意的，也在测试里钉住了 —— 否则它会悄悄退化成 FIFO。
export function createLruCache(max) {
  const limit = Math.max(1, Math.floor(Number(max) || 1));
  // Map 保证插入顺序，因此「第一个 key」就是最久未使用的。
  const map = new Map();

  return {
    get size() {
      return map.size;
    },
    has(key) {
      return map.has(key);
    },
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      // 触碰即移到队尾：少了这两行就只是 FIFO，最近看过的反而会先被淘汰
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      // 超出容量时从最久未使用的开始丢，直到回到上限
      while (map.size > limit) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    },
    delete(key) {
      return map.delete(key);
    },
    clear() {
      map.clear();
    },
    /** 便于测试与诊断：按「最久未使用 → 最近使用」返回 key。 */
    keys() {
      return Array.from(map.keys());
    },
  };
}
