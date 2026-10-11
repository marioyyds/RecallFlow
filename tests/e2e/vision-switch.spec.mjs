// **视觉（多模态）两臂对照门禁**（docs/remaining-work.md「二、① 多模态」第 7 步）。
//
// ## 它证什么
//
// 捕获 **Agent 真实发往 LLM 的请求体**（夹具的 `getLlmRequests()`），断言两件事：
//   · **关闭臂（今天）**：所有捕获到的请求里**不得出现任何图像内容**（`content` 数组里的
//     `image_url` 部件）—— 这就是"开关关闭 ⇒ 模型可见内容零变化"的对照组 ✓
//   · **开启臂（未来）**：**必须**出现图像内容，且形态正确 —— 图片在
//     `take_screenshot` 的 **tool 消息之后**、作为**追加的 `user` 消息**出现，
//     而 `tool` 消息本身仍是纯文本 ✓
//
// ## 为什么断言臂由**常量的实际值**决定，而不是写死
//
// 若写死"今天没有图"，那么开关一打开这条门禁就会**红着**，而修它的最省事做法是删掉断言 ✗。
// 现在两臂的断言都写在文件里，`VISION_ENABLED` 决定**跳过哪一臂** ⇒
// 开关一打开，同一份门禁自动变成开启臂，不会出现"开了但没人管" ✓
//
// ## 为什么它不是一个"能力剧本"（PLAYBOOKS）
//
// 它验的是**传输管道**（截图结果怎么进上下文），不是一条新的页面操作能力：
// 没有新夹具页、没有新技能、也不该被算进"能力清单"。
// 所以触发词在夹具里用**字面量**（见 fixtures/server.mjs 的那个场景块），
// 相应地它**没有** `x.playbook` 技能、也没有 `eval.instruction` —— 这是**有意**的 ✓
//
// ## 真截图 vs 降级
//
// 这里走的是**真截图**：真 Chromium + 真扩展 + `cdpEnabled: true`，
// `take_screenshot` 经 `chrome.debugger` 的 `Page.captureScreenshot` 拿到真 base64
// （实测 1280×705 JPEG q40 ≈ 63KB），不是"在 mock 层塞一张假图"那种降级做法 ✓
// 证明"截图真的成功"的方式按臂取锚点：开了截图那一臂看 `已截图` 这句工具结果，
// 没开的那一臂看最后那步**文本读回**（`计算样式`）——
// 两臂都能证明"脚本真的走完了"，否则"请求里没有图"可能只是"什么都没发生"，什么也证不出 ✗
import { test, expect } from '@playwright/test';
import {
  launchExtension,
  closeExtension,
  configureSettings,
  openFixturePage,
  sendInstruction,
} from './helpers.mjs';
import { getLlmRequests, resetLlmRequests, toolResultsText } from './fixtures/server.mjs';
import { VISION_ENABLED } from '../../lib/shared/utils.js';

let context;

test.beforeAll(async () => {
  context = await launchExtension();
});

test.afterAll(async () => {
  await closeExtension(context);
});

// 触发词与夹具里的分派字面量**逐字一致**（改一处必须改另一处 —— 见夹具那段注释）。
const INSTRUCTION = '给这个页面来张截图，并把正文的字号读出来给我。';

// 夹具这一轮到底有没有真的调 `take_screenshot`（= `E2E_LLM_VISION_SHOT=1` 那一臂）。
// 与 fixtures/server.mjs 里的判据**同一条件**：这个开关只决定"要不要发起截图"，
// 与 `VISION_ENABLED`（要不要把图送进上下文）是两件事 —— 这正是本门禁要对照的两个变量。
const VISION_SHOT_ARM = /^(1|true|yes)$/i.test(String(process.env.E2E_LLM_VISION_SHOT || ''));

// ---------------- 判据（全部是纯函数，便于"门禁自己有牙齿"那条直接验判定逻辑）----------------

/** 一条 message 里的图像部件数（`content` 是数组形态时才有）。 */
function imagePartsInMessage(msg) {
  if (!msg || !Array.isArray(msg.content)) return 0;
  return msg.content.filter((p) => p && (p.type === 'image_url' || p.type === 'image' || p.image_url)).length;
}

/** 夹具记录下来的**所有请求**里的图像部件总数（关闭臂要求恒为 0）。 */
function countImagePartsInRequests(requests) {
  let n = 0;
  for (const r of requests || []) for (const m of r.messages || []) n += imagePartsInMessage(m);
  return n;
}

/** 图像部件出现在**第几条消息**里（返回消息下标数组；`-1` 表示没找到）。 */
function messageIndicesWithImages(messages) {
  const out = [];
  (messages || []).forEach((m, i) => {
    if (imagePartsInMessage(m) > 0) out.push(i);
  });
  return out;
}

/** 含某段文本的 tool 消息下标（取第一条；没有则 -1）。 */
function toolMessageIndexOf(messages, needle) {
  return (messages || []).findIndex(
    (m) => m && m.role === 'tool' && typeof m.content === 'string' && m.content.includes(needle)
  );
}

/**
 * 形态判据：**图片必须作为 `take_screenshot` 结果之后追加的 user 消息出现，且 tool 消息保持纯文本**。
 *
 * 抽成纯函数是为了让它可被"有牙齿"那条测试注入坏数据验一遍 ——
 * 只断言"有 image_url"是不够的：塞进 tool 消息同样"请求里有图"，
 * 但那是**工具消息只能是文本**这条硬约束的违例 ✗
 */
function checkScreenshotImageShape(messages) {
  const shotIdx = toolMessageIndexOf(messages, '已截图');
  if (shotIdx < 0) return { ok: false, why: '找不到含「已截图」的 tool 消息（截图没成功？那这条门禁证不出东西）' };
  const shot = messages[shotIdx];
  // ① tool 消息本身必须是纯文本（数组形态说明图被塞进去了）
  if (Array.isArray(shot.content)) return { ok: false, why: 'tool 消息的 content 不是字符串（图被塞进了工具消息 ✗）' };
  if (/data:image\//.test(shot.content)) return { ok: false, why: 'tool 消息里出现了 base64 图像（会白烧巨量 token ✗）' };
  // ② 它后面必须有一条带图的 user 消息
  const imgIdx = messageIndicesWithImages(messages).filter((i) => i > shotIdx);
  if (!imgIdx.length) return { ok: false, why: '截图工具结果之后没有任何带图消息（图没进上下文）' };
  const img = messages[imgIdx[0]];
  if (img.role !== 'user') return { ok: false, why: '带图消息的 role 是 ' + img.role + '（应当作为**追加的 user 消息**）' };
  // ③ 文本部件要先说明"这是刚截的图"，再跟 image_url 部件
  const textPart = (img.content || []).find((p) => p && p.type === 'text');
  if (!textPart || !/截图/.test(String(textPart.text || ''))) {
    return { ok: false, why: '带图 user 消息缺少说明文本（模型会不知道那是什么图）' };
  }
  const urls = (img.content || []).filter((p) => p && p.type === 'image_url').map((p) => String((p.image_url || {}).url || ''));
  if (!urls.length || !urls.every((u) => u.startsWith('data:image/'))) {
    return { ok: false, why: 'image_url 不是 data:image/... 形态：' + JSON.stringify(urls.map((u) => u.slice(0, 24))) };
  }
  return { ok: true, shotIdx, imgIdx: imgIdx[0], images: urls.length };
}

/** 供失败信息用：只截取形态，**不打印 base64**（几 MB 的 base64 会让输出无法阅读）。 */
function shapeOfRequests(requests) {
  return (requests || []).map((r, i) => {
    const msgs = (r.messages || []).map((m) => {
      const imgs = imagePartsInMessage(m);
      const len = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
      return m.role + (imgs ? '[img:' + imgs + ']' : '') + '(' + len + '字符)';
    });
    return '#' + i + ' ' + msgs.join(' → ');
  });
}

// ---------------- 关闭臂（今天）----------------

test('关闭臂（VISION_ENABLED=false）：Agent 发往 LLM 的请求里不得出现任何图像内容', async () => {
  test.skip(VISION_ENABLED !== false, '开关已打开 ⇒ 本臂不再适用（见开启臂那条）');

  await configureSettings(context, { cdpEnabled: true });
  const page = await openFixturePage(context, '/article');
  resetLlmRequests();
  await sendInstruction(page, INSTRUCTION);

  // ① 截图链路**真的走过了**（否则"没有图"可能只是"没有截图"，证不出任何东西）。
  //
  // ⚠ 这一句必须按**臂**取锚点（第一版写错了，实测踩到）：关闭臂根本不会发起 take_screenshot
  // （截图链路今天不产出任何东西，发起它也只是白烧一枪），所以锚点是**最后那步文本读回**；
  // 只有开启臂才有「已截图」这句工具结果。
  const anchor = VISION_SHOT_ARM ? '已截图' : '计算样式（命中 1 个）';
  await expect.poll(() => toolResultsText(), { timeout: 45_000 }).toContain(anchor);
  // 文本证据（计算样式读数）在**两臂**都必须到模型手里 —— 这是"像素不替代文本"的对照
  await expect.poll(() => toolResultsText(), { timeout: 30_000 }).toContain('font-size=11px');

  // ② 关键断言：全部捕获请求里图像部件数为 0
  const requests = getLlmRequests();
  const total = countImagePartsInRequests(requests);
  expect(
    total,
    '关闭臂不该有任何图像内容，实际 ' + total + ' 个部件。请求形态：\n' + shapeOfRequests(requests).join('\n')
  ).toBe(0);

  // ③ 反向自检：判据本身不是恒 0 —— 捕获确实发生了，且**没有任何** data URL 出现在文本里
  //    （⚠ 不要在这里断言 `allText` 含「已截图」：没开截图那一臂时脚本不发起截图，
  //      那条断言会变成"按臂分叉的第二个锚点"，与 ① 重复且更容易漂移）
  const allText = requests.map((r) => (r.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')).join('\n');
  expect(requests.length, '没有捕获到任何请求 ⇒ 门禁是空的').toBeGreaterThan(0);
  expect(allText).not.toContain('data:image/');
  // ④ 证明这条门禁真的看到了东西：截图**文本**结果确实曾作为 tool 消息发出去过
  //    （`toolResultsText()` 只拼 role=tool 的字符串 content ⇒ 有它 = 有纯文本工具结果）
  expect(toolResultsText()).toContain(VISION_SHOT_ARM ? '已截图' : '计算样式（命中 1 个）');

  await page.close();
});

// ---------------- 开启臂（未来）----------------

test('开启臂（VISION_ENABLED=true）：图像必须以「截图结果之后追加的 user 消息」出现', async () => {
  test.skip(VISION_ENABLED !== true, '开关还是关的 ⇒ 本臂今天不可能成立（这正是要跳过的原因）');

  await configureSettings(context, { cdpEnabled: true });
  const page = await openFixturePage(context, '/article');
  resetLlmRequests();
  await sendInstruction(page, INSTRUCTION);

  await expect.poll(() => toolResultsText(), { timeout: 45_000 }).toContain('已截图');

  const requests = getLlmRequests();
  expect(
    countImagePartsInRequests(requests),
    '开启臂必须出现图像内容。请求形态：\n' + shapeOfRequests(requests).join('\n')
  ).toBeGreaterThan(0);

  // 逐条请求检查形态（任何一条带图的请求都必须满足"tool 纯文本 + 追加 user 消息"）
  const problems = [];
  for (const r of requests) {
    if (countImagePartsInRequests([r]) === 0) continue;
    const v = checkScreenshotImageShape(r.messages);
    if (!v.ok) problems.push(v.why);
  }
  expect(problems, '带图请求的形态不对：\n' + problems.join('\n')).toEqual([]);

  await page.close();
});

// ---------------- 门禁自己有牙齿（不需要浏览器）----------------
//
// 为什么必须有这一段：门禁写错时最典型的坏法是**恒真**（永远通过），
// 而"恒真的门禁"比没有门禁更糟 —— 它让人以为覆盖了。
// 下面用**构造出来的坏数据**验证判定逻辑真的会咬人，并说明它咬的是哪一类错。

test('这条门禁有牙齿：把图像塞进 tool 消息 / 少掉带图消息 / 恒真的"无图"判据，都必须被判为不合格', () => {
  const IMG = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } };
  const TEXT = (t) => ({ type: 'text', text: t });
  const good = [
    { role: 'tool', tool_call_id: 'c1', content: '已截图 1280×720 CSS px（JPEG q40，12KB）' },
    { role: 'user', content: [TEXT('以下是刚在页面上截取的 1 张截图（供你观察页面外观）。'), IMG] },
  ];
  expect(checkScreenshotImageShape(good).ok).toBe(true);
  expect(countImagePartsInRequests([{ messages: good }])).toBe(1);
  expect(messageIndicesWithImages(good)).toEqual([1]);

  // ① 图被塞进 tool 消息（工具消息只能是文本 ✗）—— "有 image_url" 这句话对，但形态错
  const inTool = [{ role: 'tool', tool_call_id: 'c1', content: [TEXT('已截图 …'), IMG] }];
  expect(checkScreenshotImageShape(inTool).ok).toBe(false);
  // ② tool 消息里出现 base64（哪怕 content 是字符串）
  const b64InTool = [{ role: 'tool', tool_call_id: 'c1', content: '已截图 …data:image/jpeg;base64,AAAA' }];
  expect(checkScreenshotImageShape(b64InTool).ok).toBe(false);
  // ③ 少掉带图消息（开关没接上）
  expect(checkScreenshotImageShape([good[0]]).ok).toBe(false);
  // ④ 带图消息的 role 不是 user
  const wrongRole = [good[0], { role: 'assistant', content: [TEXT('以下是刚截取的 1 张截图'), IMG] }];
  expect(checkScreenshotImageShape(wrongRole).ok).toBe(false);
  // ⑤ 带图消息没有说明文本
  const noText = [good[0], { role: 'user', content: [IMG] }];
  expect(checkScreenshotImageShape(noText).ok).toBe(false);
  // ⑥ 根本不是 data: URL（形态可疑）
  const httpUrl = [good[0], { role: 'user', content: [TEXT('以下是刚截取的 1 张截图'), { type: 'image_url', image_url: { url: 'https://x/y.png' } }] }];
  expect(checkScreenshotImageShape(httpUrl).ok).toBe(false);
  // ⑦ 关闭臂的判据不是恒 0：只要有一条带图消息，它就 > 0
  expect(countImagePartsInRequests([{ messages: good }]) > 0).toBe(true);
  expect(countImagePartsInRequests([{ messages: [good[0]] }])).toBe(0);
  // ⑧ 找不到截图结果时不能"默默通过"
  expect(checkScreenshotImageShape([{ role: 'user', content: [TEXT('随便')] }]).ok).toBe(false);
});
