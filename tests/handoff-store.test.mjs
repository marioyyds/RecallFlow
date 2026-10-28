// 交接包存储层：读写、createdAt 保留、容量淘汰与清理、错误路径。
import test from 'node:test';
import assert from 'node:assert/strict';

import { saveHandoff, getHandoff, listHandoffs, KEY_PREFIX, TRAIL_KEY_PREFIX, INDEX_KEY, MAX_RECORDS } from '../lib/shared/handoff-store.ts';
import { buildHandoffRecord, buildToolTrail, prepareHandoffTrail, MAX_TOOL_TRAIL } from '../lib/shared/handoff.ts';

// ⚠ 这条钉住的是 ② 「存全量」在**生产链路**上曾经整体失效的那个点：
//   面板发来的是**已建好的 record**（里面 `toolTrail` 只是交付用摘要），
//   而 `saveHandoff` 上一版会对 record **再建一次** ⇒ 独立 key 里存的其实是摘要 ✗
//   （完整轨迹根本没离开面板）⇒ 这里同时钉住"不带 extras 就是病根"与"带了才是全量"。
test('saveHandoff：record 形态必须靠 extras.trailItems 才能真的存全量', async () => {
  const { store } = installStorage();
  const id = idFor(999);
  const parts = [];
  for (let i = 0; i < 120; i++) {
    parts.push({ type: 'tool-call', callId: 'c' + i, name: 'tool' + i, args: {} });
    parts.push({ type: 'tool-result', callId: 'c' + i, status: 'completed', result: 'r' + i });
  }
  const messages = [{ role: 'assistant', parts }];
  const record = buildHandoffRecord({ id, pageUrl: 'https://x/', pageTitle: 't', messages });
  assert.equal(record.toolTrail.length, MAX_TOOL_TRAIL, '记录里交付的只是摘要');
  assert.equal(record.trailStored, 120, '记录如实写着"可检索 120 步"');

  await saveHandoff(record);
  assert.equal(
    (store[TRAIL_KEY_PREFIX + id] || []).length,
    MAX_TOOL_TRAIL,
    '不带完整轨迹时，独立 key 只能存到摘要 —— 这正是上一版的病根（记录说 120 步可检索，实际只有摘要）'
  );

  const trailItems = prepareHandoffTrail(buildToolTrail(messages)).items;
  await saveHandoff(record, { trailItems });
  assert.equal(
    (store[TRAIL_KEY_PREFIX + id] || []).length,
    120,
    '面板把完整轨迹一起带来之后，独立 key 必须真的存全量'
  );
});

// 安装 chrome.storage.local 桩（行为对齐真实 API：get 接受字符串或数组）。
function installStorage() {
  const store = {};
  const stats = { get: 0, set: 0, remove: 0 };
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          stats.get += 1;
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
          return out;
        },
        async set(obj) {
          stats.set += 1;
          Object.assign(store, obj);
        },
        async remove(keys) {
          stats.remove += 1;
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store[k];
        },
      },
    },
  };
  return { store, stats };
}

const AL = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
// 生成合法且互不相同的标识（6 位 base31 编码）
function idFor(n) {
  let s = '';
  let x = n;
  for (let i = 0; i < 6; i++) {
    s = AL[x % AL.length] + s;
    x = Math.floor(x / AL.length);
  }
  return 'RF-' + s;
}

test.beforeEach(() => {
  installStorage();
});

test.after(() => {
  globalThis.chrome = undefined;
});

test('saveHandoff + getHandoff: 往返保留全部字段', async () => {
  const saved = await saveHandoff({
    id: 'rf-7k2m9x',
    pageUrl: 'http://localhost:5173/cart',
    pageTitle: '购物车',
    messages: [{ role: 'user', content: '提交没反应' }],
    pickedElements: [{ selector: '#submit', source: { file: 'src/S.tsx', line: 42 } }],
    consoleEntries: [{ level: 'error', text: 'boom', at: 5 }],
    now: 1000,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.id, 'RF-7K2M9X');

  const got = await getHandoff('RF-7K2M9X');
  assert.equal(got.ok, true);
  assert.equal(got.record.pageTitle, '购物车');
  assert.equal(got.record.messages[0].content, '提交没反应');
  assert.equal(got.record.consoleErrors.length, 1);
  assert.equal(got.record.createdAt, 1000);
});

test('getHandoff: 标识也接受小写与省略前缀的写法', async () => {
  await saveHandoff({ id: 'RF-7K2M9X', now: 1 });
  assert.equal((await getHandoff('rf-7k2m9x')).ok, true);
  assert.equal((await getHandoff('7K2M9X')).ok, true);
});

test('getHandoff: 非法标识给出可读错误，不产生 notFound 混淆', async () => {
  const r = await getHandoff('not-an-id');
  assert.equal(r.ok, false);
  assert.equal(r.notFound, undefined);
  assert.ok(r.error.includes('标识无效'), r.error);
  assert.ok(r.error.includes('RF-7K2M9X'), r.error);
});

test('getHandoff: 未找到时说明可能原因（含保留上限）', async () => {
  const r = await getHandoff('RF-7K2M9X');
  assert.equal(r.ok, false);
  assert.equal(r.notFound, true);
  assert.ok(r.error.includes('RF-7K2M9X'), r.error);
  assert.ok(r.error.includes(String(MAX_RECORDS)), r.error);
});

test('saveHandoff: 非法 id 返回错误而不是抛异常', async () => {
  const r = await saveHandoff({ id: 'bad', messages: [] });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('合法'), r.error);
});

test('saveHandoff: 同一会话重复保存时保留首次 createdAt', async () => {
  await saveHandoff({ id: 'RF-7K2M9X', now: 1000 });
  const second = await saveHandoff({ id: 'RF-7K2M9X', now: 5000 });
  assert.equal(second.ok, true);
  const got = await getHandoff('RF-7K2M9X');
  assert.equal(got.record.createdAt, 1000, 'createdAt 应保持首次值');
  assert.equal(got.record.updatedAt, 5000, 'updatedAt 应更新');
});

test('saveHandoff: 超出上限时淘汰最旧记录并删除其存储键', async () => {
  const { store } = installStorage();
  const total = MAX_RECORDS + 3;
  for (let i = 0; i < total; i++) {
    const r = await saveHandoff({ id: idFor(i), now: 1000 + i });
    assert.equal(r.ok, true);
  }
  const index = store[INDEX_KEY];
  assert.equal(index.length, MAX_RECORDS);
  // 最新在前
  assert.equal(index[0].id, idFor(total - 1));
  // 最旧的三个键应已从存储中删除
  for (let i = 0; i < 3; i++) {
    assert.equal(store[KEY_PREFIX + idFor(i)], undefined, '应删除 ' + idFor(i));
  }
  // 最新的仍可读
  assert.equal((await getHandoff(idFor(total - 1))).ok, true);
});

test('listHandoffs: 按最近优先返回标识与时间', async () => {
  await saveHandoff({ id: idFor(1), now: 100 });
  await saveHandoff({ id: idFor(2), now: 200 });
  const r = await listHandoffs(10);
  assert.equal(r.ok, true);
  assert.equal(r.list.length, 2);
  assert.equal(r.list[0].id, idFor(2));
  assert.equal(r.list[0].at, 200);
});

test('listHandoffs: 无记录时返回空列表而非报错', async () => {
  const r = await listHandoffs();
  assert.equal(r.ok, true);
  assert.deepEqual(r.list, []);
});

test('存储不可用时三个接口都安全降级', async () => {
  globalThis.chrome = undefined;
  const s = await saveHandoff({ id: 'RF-7K2M9X' });
  assert.equal(s.ok, false);
  assert.ok(s.error.includes('存储不可用'), s.error);
  const g = await getHandoff('RF-7K2M9X');
  assert.equal(g.ok, false);
  const l = await listHandoffs();
  assert.equal(l.ok, false);
  assert.deepEqual(l.list, []);
});

// ---------------- 「存全量、交付按需取」的取回端 ----------------
//
// 起因：一次"检索动画"的会话约 60 次工具调用，而记录只留最近 24 步 ——
// 接手方看不到前面的探索，判断不了"哪些路已经试过了"，而这是交接包存在的理由。
// 现在完整轨迹另存一个 key，记录里给摘要 + 三个数（total/stored/omitted），
// 需要更早的步骤就按区间取 —— 而不是一次把几百步全灌进上下文。

/** 造 n 步轨迹（每步可辨识，便于断言区间正确）。 */
function makeTrail(n) {
  return Array.from({ length: n }, (_, i) => ({ name: 'step' + i, args: '{}', status: 'completed', result: 'r' + i }));
}

test('完整轨迹另存一个 key，记录里只给摘要（与记录预算分开）', async () => {
  const { store } = installStorage();
  const r = await saveHandoff({ id: 'RF-7K2M9X', toolTrail: makeTrail(120) });
  assert.equal(r.ok, true);
  const rec = store[KEY_PREFIX + 'RF-7K2M9X'];
  const trail = store[TRAIL_KEY_PREFIX + 'RF-7K2M9X'];
  assert.ok(Array.isArray(trail), '完整轨迹应存在独立 key 里');
  assert.equal(trail.length, 120, '独立 key 里是可检索的**全量**');
  assert.ok(rec.toolTrail.length < trail.length, '记录里只是摘要');
  assert.equal(rec.trailTotal, 120);
  assert.equal(rec.trailStored, 120);
  assert.equal(rec.trailOmitted, 0);
  // 自洽：接手方据此判断"还有更多、且都能取回"
  assert.equal(rec.trailTotal, rec.trailStored + rec.trailOmitted);
  assert.ok(rec.trailStored > rec.toolTrail.length);
});

test('按区间取回完整轨迹：trailTo 是开区间上界，越界被夹住', async () => {
  installStorage();
  await saveHandoff({ id: 'RF-7K2M9X', toolTrail: makeTrail(120) });
  // 取最早 5 步
  const head = await getHandoff('RF-7K2M9X', { trailFrom: 0, trailTo: 5 });
  assert.equal(head.ok, true);
  assert.equal(head.trail.length, 5);
  assert.deepEqual(head.trail.map((t) => t.name), ['step0', 'step1', 'step2', 'step3', 'step4']);
  assert.equal(head.trailFrom, 0);
  assert.equal(head.trailTo, 5);
  assert.equal(head.trailStored, 120);
  assert.match(head.note, /第 0–4 步/, 'note 要告诉接手方取到的是哪一段');
  // 中段
  const mid = await getHandoff('RF-7K2M9X', { trailFrom: 60, trailTo: 63 });
  assert.deepEqual(mid.trail.map((t) => t.name), ['step60', 'step61', 'step62']);
  // 越界被夹住，而不是抛错或返回垃圾
  const over = await getHandoff('RF-7K2M9X', { trailFrom: 118, trailTo: 9999 });
  assert.deepEqual(over.trail.map((t) => t.name), ['step118', 'step119']);
  assert.equal(over.trailTo, 120);
  // 只给 trailFrom：默认取到末尾
  const tail = await getHandoff('RF-7K2M9X', { trailFrom: 119 });
  assert.deepEqual(tail.trail.map((t) => t.name), ['step119']);
  // 空区间给可读说明，不是静默空数组
  const empty = await getHandoff('RF-7K2M9X', { trailFrom: 5, trailTo: 5 });
  assert.equal(empty.trail.length, 0);
  assert.match(empty.note, /开区间上界/, '空区间要解释为什么空');
});

test('不带区间参数时行为与从前一致（只返回记录，不灌全量轨迹）', async () => {
  installStorage();
  await saveHandoff({ id: 'RF-7K2M9X', toolTrail: makeTrail(120) });
  const g = await getHandoff('RF-7K2M9X');
  assert.equal(g.ok, true);
  assert.ok(g.record, '默认返回 record');
  assert.equal(g.trail, undefined, '默认**不该**把全量轨迹一并塞进返回值');
});

test('淘汰旧记录时必须连它的轨迹 key 一起删（否则留下取不到却占配额的垃圾）', async () => {
  const { store } = installStorage();
  // 存满 MAX_RECORDS + 1 条，触发一次淘汰
  for (let i = 0; i <= MAX_RECORDS; i++) {
    const r = await saveHandoff({ id: idFor(i), toolTrail: makeTrail(3) });
    assert.equal(r.ok, true, '第 ' + i + ' 条应保存成功：' + (r.error || ''));
  }
  const trailKeys = Object.keys(store).filter((k) => k.startsWith(TRAIL_KEY_PREFIX));
  const recKeys = Object.keys(store).filter((k) => k.startsWith(KEY_PREFIX));
  assert.equal(recKeys.length, MAX_RECORDS, '记录条数受上限约束');
  assert.equal(
    trailKeys.length,
    recKeys.length,
    '轨迹 key 数量必须与记录一致：多出来的就是取不到、却一直占配额的孤儿'
  );
});
