// 方案 B 阶段 0：用 DSH 自己的 JSON Schema 校验器，跑一遍 RecallFlow 现有 55 个工具 Schema。
// 目的：把「Schema 能否原样复用」从猜测变成数字 —— 结果是可行性的前提。
import { pathToFileURL } from 'node:url';

const DSH = 'C:/Users/mario/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const mod = await import(pathToFileURL(DSH + '/dsh-tools/lib/types/json-schema.js').href);

console.log('dsh-tools/json-schema 导出: ' + Object.keys(mod).join(', '));
const { assertSupportedJsonSchema, assertObjectJsonSchema } = mod;

const { TOOL_REGISTRY } = await import('../lib/assistant/tools.js');

const results = [];
for (const t of TOOL_REGISTRY) {
  const row = { name: t.name, objectOk: true, subsetOk: true, why: '' };
  try {
    assertObjectJsonSchema(t.inputSchema);
  } catch (e) {
    row.objectOk = false;
    row.why = String((e && e.message) || e);
  }
  if (row.objectOk) {
    try {
      assertSupportedJsonSchema(t.inputSchema);
    } catch (e) {
      row.subsetOk = false;
      row.why = String((e && e.message) || e);
    }
  }
  results.push(row);
}

const badObject = results.filter((r) => !r.objectOk);
const badSubset = results.filter((r) => r.objectOk && !r.subsetOk);
console.log('');
console.log('工具总数: ' + results.length);
console.log('  object 校验未通过: ' + badObject.length);
console.log('  DSH 子集校验未通过: ' + badSubset.length);
for (const r of [...badObject, ...badSubset]) {
  console.log('    - ' + r.name + '：' + r.why.slice(0, 200));
}
// 顺带看 enum 是否被卡（先前静态扫描发现 9 个工具含 enum）
const withEnum = TOOL_REGISTRY.filter((t) => JSON.stringify(t.inputSchema).includes('enum'));
const enumBad = withEnum.filter((t) => badSubset.some((b) => b.name === t.name));
console.log('');
console.log('含 enum 的工具: ' + withEnum.length + '，其中被卡: ' + enumBad.length);
console.log(
  badObject.length + badSubset.length === 0
    ? '结论：现有 55 个 Schema 全部可直接复用 → 迁移形态确实是「适配器」而非「重写」'
    : '结论：有 ' + (badObject.length + badSubset.length) + ' 个需要改写'
);
