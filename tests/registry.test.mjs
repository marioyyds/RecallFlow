import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_REGISTRY, getToolMetadata, validateToolCall, BUILTIN_TOOLS } from '../lib/assistant/tools.js';

test('every tool has a name, object schema and risk', () => {
  assert.ok(TOOL_REGISTRY.length > 0);
  for (const t of TOOL_REGISTRY) {
    assert.ok(t.name, 'tool name');
    assert.equal(t.inputSchema.type, 'object', t.name + ' schema type');
    assert.ok(typeof t.risk === 'string', t.name + ' risk');
  }
  assert.equal(BUILTIN_TOOLS.length, TOOL_REGISTRY.length);
});

test('run_javascript always requires per-call approval', () => {
  assert.equal(getToolMetadata('run_javascript').alwaysRequireApproval, true);
  assert.equal(getToolMetadata('run_javascript').requiresApproval, true);
});

test('load_skill is always available across intents', () => {
  assert.equal(getToolMetadata('load_skill').alwaysAvailable, true);
});

test('validateToolCall enforces required params', () => {
  assert.equal(validateToolCall('click_at', {}).ok, false);
  assert.equal(validateToolCall('click_at', { x: 1, y: 2 }).ok, true);
  assert.equal(validateToolCall('unknown_tool', {}).ok, false);
});
