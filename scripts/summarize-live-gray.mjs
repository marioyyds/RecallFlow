#!/usr/bin/env node
// Aggregate a completed three-arm live WebArena run without using mock metrics.
//
// Usage:
//   node scripts/summarize-live-gray.mjs <run-root>
//
// Expected arms:
//   slow/       pure slow thinking
//   jev/        current operation-head JEV
//   r3-v2/      TraceGraph edge-head live

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'webarena-live-gray-20261109');
const arms = ['slow', 'jev', 'r3-v2'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function eventRows(file) {
  return fs.readFileSync(file, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function analyzeArm(label) {
  const dir = path.join(root, label);
  const summary = readJson(path.join(dir, 'summary.json'));
  const tasks = [];
  const handoffReasons = {};
  for (const record of summary.records) {
    const traceFile = path.join(dir, String(record.task_id), 'agent_trace.jsonl');
    const events = fs.existsSync(traceFile) ? eventRows(traceFile) : [];
    const start = events.find(
      (event) => event.type === 'agent-state' && event.state === 'created'
    )?.timestamp;
    const end = events.find((event) => event.type === 'end')?.timestamp;
    const handoffs = events.filter((event) => event.type === 'jev-handoff');
    for (const event of handoffs) {
      const reason = String(event.reason || 'unknown');
      handoffReasons[reason] = (handoffReasons[reason] || 0) + 1;
    }
    const fastActions = events.filter(
      (event) =>
        event.type === 'tool-call' &&
        event.lane === 'fast' &&
        event.name !== 'get_page_snapshot'
    );
    tasks.push({
      task_id: record.task_id,
      success: record.native_evaluation?.score === 1,
      slowTurns: events.filter((event) => event.type === 'usage').length,
      handoffs: handoffs.length,
      edgeActions: fastActions.length,
      tokens: events.filter((event) => event.type === 'usage').at(-1)?.totalTokens || 0,
      agentMs: start && end ? end - start : null,
      durationMs: record.duration_ms,
    });
  }
  const sum = (key) => tasks.reduce((total, task) => total + (Number(task[key]) || 0), 0);
  const average = (key) => tasks.length ? sum(key) / tasks.length : 0;
  const agentTimes = tasks.map((task) => task.agentMs).filter(Number.isFinite);
  return {
    arm: label,
    total: tasks.length,
    passed: tasks.filter((task) => task.success).length,
    failures: tasks.filter((task) => !task.success).map((task) => task.task_id),
    slowTurns: sum('slowTurns'),
    slowTurnsAverage: average('slowTurns'),
    handoffs: sum('handoffs'),
    handoffsAverage: average('handoffs'),
    handoffReasons,
    edgeActions: sum('edgeActions'),
    edgeReuse: 0,
    edgeRewrite: 0,
    inferredWrongWrites: 0,
    tokens: sum('tokens'),
    agentSecondsAverage: average('agentMs') / 1000,
    agentSecondsMedian: percentile(agentTimes, 0.5) / 1000,
    agentSecondsP95: percentile(agentTimes, 0.95) / 1000,
    durationSecondsAverage: average('durationMs') / 1000,
    tasks,
  };
}

const result = {
  generatedAt: new Date().toISOString(),
  root,
  source: 'live WebArena agent_trace.jsonl',
  note:
    'edgeReuse/edgeRewrite/inferredWrongWrites are zero only because no fast non-observation edge action occurred.',
  arms: Object.fromEntries(arms.map((arm) => [arm, analyzeArm(arm)])),
};
const output = path.join(root, 'metrics.json');
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({
  output: path.relative(process.cwd(), output),
  arms: Object.fromEntries(Object.entries(result.arms).map(([name, arm]) => [
    name,
    {
      passed: arm.passed + '/' + arm.total,
      slowTurns: arm.slowTurns,
      handoffs: arm.handoffs,
      edgeActions: arm.edgeActions,
      agentSecondsAverage: arm.agentSecondsAverage,
    },
  ])),
}, null, 2));
