import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { AI_SETTINGS_DEFAULTS, JEV_SETTINGS_DEFAULTS, mergeJevSettings } from '../lib/shared/settings.ts';

const OPTIONS_HTML = fs.readFileSync('options.html', 'utf8');

test('默认模型是 deepseek-flash', () => {
  assert.equal(AI_SETTINGS_DEFAULTS.model, 'deepseek-flash');
});

test('设置页的模型输入与候选列表包含 deepseek-flash', () => {
  assert.match(OPTIONS_HTML, /placeholder="deepseek-flash"/);
  assert.match(OPTIONS_HTML, /<option value="deepseek-flash">/);
});

test('设置页说明 run_javascript 已归入页面命令审批', () => {
  assert.match(OPTIONS_HTML, /run_javascript 已归入「执行页面命令」/);
  assert.match(OPTIONS_HTML, /用户脚本 \/ 技能写入审批/);
});

test('设置页提供独立的远程 JEV 配置', () => {
  assert.equal(JEV_SETTINGS_DEFAULTS.enabled, false);
  assert.equal(AI_SETTINGS_DEFAULTS.jev.schemaVersion, 'jev.recallflow.v1');
  for (const id of [
    'jev-enabled',
    'jev-shadow-mode',
    'jev-base-url',
    'jev-api-key',
    'jev-model',
    'jev-timeout',
    'jev-retries',
    'jev-max-attempts',
    'jev-max-actions',
    'jev-max-repeated',
    'jev-max-candidates',
    'jev-min-read',
    'jev-min-action',
    'jev-min-click',
    'jev-min-wait',
    'jev-min-target-operation',
    'jev-schema-version',
    'test-jev',
    'jev-status',
  ]) {
    assert.match(OPTIONS_HTML, new RegExp('id="' + id + '"'));
  }
  assert.match(OPTIONS_HTML, /JEV 是独立的远程结构化决策模型/);
});

test('旧设置的 JEV 配置缺失字段时补默认值并限制数值范围', () => {
  assert.deepEqual(mergeJevSettings({ model: 'jev-m1' }), {
    ...JEV_SETTINGS_DEFAULTS,
    model: 'jev-m1',
  });
  assert.equal(mergeJevSettings({ requestTimeoutMs: 1 }).requestTimeoutMs, 15000);
  assert.equal(mergeJevSettings({ requestTimeoutMs: 999999 }).requestTimeoutMs, 120000);
  assert.equal(mergeJevSettings({ maxRetries: 99 }).maxRetries, 3);
  assert.equal(mergeJevSettings({ maxAttemptsPerRun: 0 }).maxAttemptsPerRun, 1);
  assert.equal(mergeJevSettings({ maxAttemptsPerRun: 999 }).maxAttemptsPerRun, 200);
  assert.equal(mergeJevSettings({ maxConsecutiveActions: 0 }).maxConsecutiveActions, 1);
  assert.equal(mergeJevSettings({ maxConsecutiveActions: 999 }).maxConsecutiveActions, 50);
  assert.equal(
    mergeJevSettings({ maxRepeatedActionsWithoutProgress: 0 })
      .maxRepeatedActionsWithoutProgress,
    1
  );
  assert.equal(
    mergeJevSettings({ maxRepeatedActionsWithoutProgress: 99 })
      .maxRepeatedActionsWithoutProgress,
    10
  );
  assert.equal(mergeJevSettings({ maxElementCandidates: 1 }).maxElementCandidates, 5);
  assert.equal(mergeJevSettings({ maxElementCandidates: 999 }).maxElementCandidates, 100);
  assert.equal(mergeJevSettings({ minReadConfidence: -1 }).minReadConfidence, 0);
  assert.equal(mergeJevSettings({ minActionConfidence: 2 }).minActionConfidence, 1);
  assert.equal(mergeJevSettings({ minClickConfidence: 0.91 }).minClickConfidence, 0.91);
  assert.equal(mergeJevSettings({ minWaitConfidence: 0.44 }).minWaitConfidence, 0.44);
  assert.equal(
    mergeJevSettings({ minTargetOperationConfidence: 0.79 })
      .minTargetOperationConfidence,
    0.79
  );
  assert.equal(mergeJevSettings({ baseUrl: ' https://example.com/// ' }).baseUrl, 'https://example.com');
  assert.equal(mergeJevSettings({ shadowMode: false }).shadowMode, false);
});
