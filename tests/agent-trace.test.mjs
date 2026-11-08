import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentTraceRecorder, buildTraceDigest, redactTraceSettings } from '../integrations/webarena/trace.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recallflow-trace-'));
}

test('AgentTraceRecorder：每批增量立即写入完整事件，元数据不泄露密钥', async () => {
  const dir = tempDir();
  try {
    const trace = new AgentTraceRecorder({
      taskDir: dir,
      taskId: 17,
      instruction: '搜索商品',
      settings: {
        model: 'deepseek-flash',
        apiKey: 'chat-secret',
        jev: { enabled: true, shadowMode: false, model: 'jev-latest', apiKey: 'jev-secret' },
        __pollMs: 500,
      },
      startedAt: 1000,
    });
    trace.recordProgress({
      seq: 2,
      state: 'running',
      omitted: 0,
      raw: {
        jobId: 'job-1',
        events: [
          {
            seq: 1,
            at: 1100,
            type: 'tool-call',
            name: 'TYPE_TEXT',
            args: { ref: 'e7', text: '完整参数' },
            lane: 'fast',
          },
          {
            seq: 2,
            at: 1200,
            type: 'tool-result',
            name: 'TYPE_TEXT',
            status: 'completed',
            result: '完整结果',
            lane: 'fast',
          },
        ],
      },
    });

    const linesNow = (await fs.promises.readFile(path.join(dir, 'agent_trace.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(linesNow.length, 2, '轮询后必须立刻可读，不能等任务结束');
    assert.deepEqual(JSON.parse(linesNow[0]).args, { ref: 'e7', text: '完整参数' });

    trace.recordProgress({
      seq: 3,
      state: 'completed',
      omitted: 0,
      raw: {
        jobId: 'job-1',
        events: [{ seq: 3, at: 1300, type: 'jev-decision', lane: 'fast', decision: { action: 'TYPE_TEXT' } }],
      },
    });
    trace.finish({
      job: { jobId: 'job-1', state: 'completed' },
      response: { status: 'SUCCESS' },
      har: 'network.har',
    });

    const lines = (await fs.promises.readFile(path.join(dir, 'agent_trace.jsonl'), 'utf8')).trim().split('\n');
    assert.deepEqual(lines.map((line) => JSON.parse(line).seq), [1, 2, 3]);
    assert.equal(JSON.parse(lines[1]).result, '完整结果');

    const meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'agent_trace.meta.json'), 'utf8'));
    assert.equal(meta.task_id, 17);
    assert.equal(meta.state, 'completed');
    assert.equal(meta.capture.complete, true);
    assert.equal(meta.capture.recorded_events, 3);
    assert.equal(meta.capture.event_counts['jev-decision'], 1);
    assert.equal(meta.jev.enabled, true);
    assert.equal(meta.polling.configured_ms, 500);
    assert.equal(meta.settings, undefined);
    assert.ok(!JSON.stringify(meta).includes('chat-secret'));
    assert.ok(!JSON.stringify(meta).includes('jev-secret'));
    assert.equal(meta.readable.steps_file, 'agent_trace.steps.jsonl');
    assert.equal(meta.readable.markdown_file, 'agent_trace.md');
    const markdown = await fs.promises.readFile(path.join(dir, 'agent_trace.md'), 'utf8');
    assert.match(markdown, /工具：TYPE_TEXT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AgentTraceRecorder：omitted 或序列缺口都不会被标成完整轨迹', async () => {
  const dir = tempDir();
  try {
    const trace = new AgentTraceRecorder({ taskDir: dir, taskId: 18, instruction: '测试', startedAt: 1000 });
    trace.recordProgress({
      seq: 3,
      state: 'running',
      omitted: 2,
      raw: { jobId: 'job-2', events: [{ seq: 3, at: 1100, type: 'chunk', text: '尾部' }] },
    });
    const capture = trace.finish({ job: { jobId: 'job-2', state: 'failed', error: '超时' } });
    assert.equal(capture.complete, false);
    assert.equal(capture.omitted, 2);
    assert.deepEqual(capture.gaps, [{ after: 0, before: 3, missing: 2 }]);
    const meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'agent_trace.meta.json'), 'utf8'));
    assert.equal(meta.state, 'failed');
    assert.equal(meta.error, '超时');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('redactTraceSettings：递归抹掉常见凭据字段', () => {
  const value = redactTraceSettings({
    apiKey: 'a',
    nested: { password: 'b', bridgeToken: 'c', model: 'm' },
    array: [{ authorization: 'd' }],
  });
  assert.equal(value.apiKey, '[REDACTED]');
  assert.equal(value.nested.password, '[REDACTED]');
  assert.equal(value.nested.bridgeToken, '[REDACTED]');
  assert.equal(value.nested.model, 'm');
  assert.equal(value.array[0].authorization, '[REDACTED]');
});

test('buildTraceDigest：合并逐 token 文本，并把 tool-call/result 配成一步', () => {
  const steps = buildTraceDigest([
    { seq: 1, at: 1000, type: 'reasoning', lane: 'slow', text: '先想' },
    { seq: 2, at: 1001, type: 'reasoning', lane: 'slow', text: '一下' },
    {
      seq: 3,
      at: 1002,
      type: 'tool-call',
      lane: 'fast',
      callId: 'c1',
      name: 'click_element',
      args: { ref: 'e4' },
    },
    { seq: 4, at: 1003, type: 'tool-result', lane: 'fast', callId: 'c1', status: 'completed', result: 'ok' },
    { seq: 5, at: 1004, type: 'chunk', lane: 'slow', text: '已在' },
    { seq: 6, at: 1005, type: 'chunk', lane: 'slow', text: '后台完成。' },
  ]);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].kind, 'reasoning');
  assert.equal(steps[0].text, '先想一下');
  assert.equal(steps[0].seq_end, 2);
  assert.equal(steps[1].kind, 'tool');
  assert.deepEqual(steps[1].args, { ref: 'e4' });
  assert.equal(steps[1].result, 'ok');
  assert.equal(steps[2].text, '已在后台完成。');
});

test('AgentTraceRecorder：补执行使用独立 attempt，原始 seq 可重复但落盘序号不重复', async () => {
  const dir = tempDir();
  try {
    const trace = new AgentTraceRecorder({ taskDir: dir, taskId: 19, instruction: 'x', startedAt: 1000 });
    trace.recordProgress({
      seq: 1,
      state: 'completed',
      omitted: 0,
      raw: { jobId: 'job-a', events: [{ seq: 1, at: 1100, type: 'chunk', text: 'A' }] },
    }, { attempt: 1 });
    trace.recordProgress({
      seq: 1,
      state: 'completed',
      omitted: 0,
      raw: { jobId: 'job-b', events: [{ seq: 1, at: 1200, type: 'chunk', text: 'B' }] },
    }, { attempt: 2 });
    trace.finish({ job: { jobId: 'job-b', state: 'completed' }, response: { status: 'SUCCESS' } });
    const events = (await fs.promises.readFile(path.join(dir, 'agent_trace.jsonl'), 'utf8'))
      .trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map((event) => event.seq), [1, 2]);
    assert.deepEqual(events.map((event) => event.attempt), [1, 2]);
    assert.deepEqual(events.map((event) => event.attempt_seq), [1, 1]);
    const meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'agent_trace.meta.json'), 'utf8'));
    assert.equal(meta.attempts.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
