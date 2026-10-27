// 非法 Unicode（孤立代理对 / lone surrogate）的清理，以及「不切裂代理对」的安全切片。
//
// 为什么值得单独一个模块：这是一次**线上事故的根因**，而不是洁癖。
//
// 事故链条（2026-10-16，会话 RF-YBKAN7）：
//   ① 表格单元格按 `s.slice(0, 60)` 截断（见 table.js），而论文页面里的
//      `𝑦 / 𝒜 / 𝐺 / 𝐽` 都是星形平面字符 —— 在 UTF-16 里各占 **2 个码元**；
//   ② 切点正好落在高位代理上时，字符串里就留下一个**没有低位配对的孤立代理**；
//   ③ 它进了 tool 消息的 content。`JSON.stringify` 把它转义成 `\ud835`：
//      JSON 语法合法，但解出来不是合法 Unicode；
//   ④ 服务端在**解析请求体**阶段整单拒收：400，响应体是纯文本
//      `Failed to parse the request body as JSON: messages[N].content: unexpected end of hex escape …`
//      （已用最小探针复核：同样内容把那半个字符换成完整字符对就是 200）；
//   ⑤ 当时的错误捕获先 `resp.json()` 再 `resp.text()` —— 非 JSON 的响应体让 json() 抛错，
//      而**体已经被读走**，text() 再抛 "Body is unusable"，于是原因被吞掉，
//      表现为「400 且冒号后什么都没有」。400 又不在重试白名单里 ⇒ 一次即死；
//   ⑥ 坏内容留在历史里（还落了盘）⇒ 同一条会话续跑必然再炸。
//
// 所以这里做两件事，**两件都要**：
//   ① sliceSafe / rangeSafe —— 根因：任何按下标的截断都不许切裂代理对；
//   ② sanitizeLoneSurrogates / sanitizeMessages —— 兜底：内容可能来自页面
//      （例如 `run_javascript` 里模型自己写的 `innerText.slice(a, b)`），
//      我们无法控制它，只能在出站前把孤立代理换成 U+FFFD。

/** U+FFFD：Unicode 官方的「替换字符」，表示"这里有一个无法表示的码元"。 */
export const REPLACEMENT = '\uFFFD';

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * 找出所有孤立代理的下标（高位后面不是低位 / 低位前面不是高位）。
 * 纯诊断用：`sanitizeLoneSurrogates` 内部也走同一套判据，避免两处判据漂移。
 */
export function loneSurrogateIndexes(text: unknown): number[] {
  const s = String(text === undefined || text === null ? '' : text);
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isHigh(c)) {
      const next = s.charCodeAt(i + 1);
      if (isLow(next)) {
        i += 1; // 合法配对，跳过低位
      } else {
        out.push(i);
      }
    } else if (isLow(c)) {
      out.push(i);
    }
  }
  return out;
}

/** 是否含孤立代理（用于零成本短路）。 */
export function hasLoneSurrogate(text: unknown): boolean {
  if (typeof text !== 'string' || !text) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isHigh(c)) {
      if (isLow(text.charCodeAt(i + 1))) {
        i += 1;
        continue;
      }
      return true;
    }
    if (isLow(c)) return true;
  }
  return false;
}

/**
 * 把孤立代理逐个替换成 U+FFFD。
 *
 * 为什么不直接删掉：删掉会让「这里原本有一个字符」这件事消失，
 * 模型读到的文本会静默变短（和"截断不标注"是同一类谎）；U+FFFD 是 Unicode
 * 规定的"这里有个表示不出来的字符"，信息量更大也更诚实。
 *
 * 无孤立代理时**原样返回同一个字符串**（不新建对象）：这个函数在出站路径上会被
 * 高频调用，绝大多数内容都是干净的。
 */
export function sanitizeLoneSurrogates(text: string, replacement: unknown = REPLACEMENT): string {
  if (typeof text !== 'string' || !text) return text;
  const idx = loneSurrogateIndexes(text);
  if (!idx.length) return text;
  const rep = String(replacement);
  let out = '';
  let prev = 0;
  for (const i of idx) {
    out += text.slice(prev, i) + rep;
    prev = i + 1;
  }
  return out + text.slice(prev);
}

// 深度上限：消息结构是固定几层（message → content[] → part → 字段），
// 给到 6 层足够，同时挡住病态/自引用结构把出站路径挂住。
const MAX_WALK_DEPTH = 6;

/**
 * 把对象里**所有**字符串字段过一遍 apply（含嵌套数组/对象）。
 *
 * 为什么不用字段白名单：白名单会漂移 —— 今天不知道明天谁会往消息里加一个
 * 带页面文本的字段（视觉消息的 `image_url.url`、未来某个工具的输出字段…），
 * 而漏掉一个的代价是"整个 run 一次即死"。这里改字符串值本身，
 * **不改结构、不增删字段、不改非字符串**，所以不会改语义。
 */
function walkStrings(node: unknown, apply: (s: string) => string, depth = 0): void {
  if (depth > MAX_WALK_DEPTH || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) {
      if (typeof v === 'string') continue; // 数组里的裸字符串由调用方决定是否处理
      walkStrings(v, apply, depth + 1);
    }
    return;
  }
  const rec = node as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (typeof v === 'string') {
      const next = apply(v);
      if (next !== v) rec[k] = next;
    } else {
      walkStrings(v, apply, depth + 1);
    }
  }
}

/**
 * 就地清理一组 messages 里的孤立代理，返回**修了几处**。
 *
 * 设计取舍：**就地改**而不是返回新数组。
 *   - 调用方（agent 主循环）在几十处闭包里共享同一个数组对象，换对象会立刻失配；
 *   - 而且我们**希望**历史被修好：坏内容留在历史里，续跑会每轮再炸一次。
 * 代价：历史中部被改写会让前缀缓存从改写点起失效 —— 但只在真的发现孤立代理时才会发生，
 * 而那种情况下"缓存失效"远好于"整个 run 一次即死"。
 */
export function sanitizeMessages<T>(messages: T): { count: number; messages: T } {
  const list = (Array.isArray(messages) ? messages : []) as unknown[];
  let count = 0;
  const apply = (s: string): string => {
    const fixed = sanitizeLoneSurrogates(s);
    if (fixed !== s) count += loneSurrogateIndexes(s).length;
    return fixed;
  };
  for (const m of list) {
    if (!m || typeof m !== 'object' || !(m as { role?: unknown }).role) continue;
    // content 可能是字符串，也可能是 part 数组（视觉消息）—— 统一交给深度遍历。
    // 数组里的裸字符串（content: ['a','b'] 这种形态）不属于 OpenAI 规范，这里不碰：
    // 出站消毒只修"不该出现的字符"，不顺手改写不认识的结构。
    walkStrings(m, apply);
  }
  return { count, messages: list as T };
}

/**
 * 按 slice 的下标语义归一化区间，并把两端对齐到**字符（码点）边界**。
 *
 * 对齐规则：边界落在配对中间时**向后回退**（宁可少一个字符，也不产生半个字符）。
 * 为什么不向前扩：所有调用点都是「上限」语义（maxCellChars / 3000 字符预算），
 * 向前扩会破坏"不许超过上限"这个约定。
 *
 * @returns {{start:number, end:number}} start ≤ end，且都不在配对中间
 */
export function alignRange(text: unknown, start?: unknown, end?: unknown): { start: number; end: number } {
  const s = String(text === undefined || text === null ? '' : text);
  const len = s.length;
  const clamp = (v: unknown, fallback: number): number => {
    if (v === undefined || v === null) return fallback;
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return n < 0 ? Math.max(0, len + n) : Math.min(len, n);
  };
  let a = clamp(start, 0);
  let b = clamp(end, len);
  if (b < a) b = a;
  // 起点是"孤立的低位"（它的高位在区间外）→ 退回一格，把整对一起带上
  if (a > 0 && a < len && isLow(s.charCodeAt(a)) && isHigh(s.charCodeAt(a - 1))) a -= 1;
  // 终点是"孤立的低位"（它的高位在区间内）→ 前移一格，把这一对整体排除
  if (b > 0 && b < len && isLow(s.charCodeAt(b)) && isHigh(s.charCodeAt(b - 1))) b -= 1;
  return { start: a, end: b };
}

/** `String.prototype.slice` 的安全版：同样的下标语义，但绝不切裂代理对。 */
export function sliceSafe(text: unknown, start?: unknown, end?: unknown): string {
  const s = String(text === undefined || text === null ? '' : text);
  const { start: a, end: b } = alignRange(s, start, end);
  return s.slice(a, b);
}

/**
 * 和 sliceSafe 一样安全，但同时告诉你**实际取到了哪一段**。
 * 需要把区间如实写进结果文本时用它（例如 expand_result 的 `[offset, end)` 标注）：
 * 边界被回退后，沿用请求的 offset 就是一句假话。
 */
export function rangeSafe(text: unknown, start?: unknown, end?: unknown) {
  const s = String(text === undefined || text === null ? '' : text);
  const { start: a, end: b } = alignRange(s, start, end);
  return { start: a, end: b, text: s.slice(a, b), length: s.length };
}
