import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JEV_CLICK_TARGET_QUESTION,
  JEV_OPERATION_QUESTION,
  JEV_TYPE_TEXT_TARGET_QUESTION,
  buildJevFastRequest,
  interpretJevFastDecision,
} from '../lib/application/agent/jev-action-space.ts';
import { callJevSystemOne } from '../lib/application/agent/jev-client.ts';
import { JEV_CALIBRATION_SCENARIOS } from '../tests/e2e/jev-scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '.jev-eval');

function configuredProxy() {
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Node 内置 fetch 不读取 HTTP(S)_PROXY。这里用 HTTP CONNECT 建立真正的
 * HTTPS 隧道，再交给 https.request，确保校准请求与浏览器走同一个出口。
 */
async function proxyAwareFetch(input, init = {}) {
  const target = new URL(String(input));
  const proxy = configuredProxy();
  if (!proxy || target.protocol !== 'https:') return fetch(input, init);
  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: target.hostname + ':' + (target.port || 443),
      headers: { Host: target.hostname + ':' + (target.port || 443) },
    });
    let outerRequest = null;
    const abort = () => {
      connect.destroy();
      outerRequest?.destroy();
      reject(new DOMException('任务已取消', 'AbortError'));
    };
    if (init.signal?.aborted) {
      abort();
      return;
    }
    init.signal?.addEventListener('abort', abort, { once: true });
    connect.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        init.signal?.removeEventListener('abort', abort);
        reject(new Error('代理 CONNECT 失败：HTTP ' + response.statusCode));
        socket.destroy();
        return;
      }
      if (head?.length) socket.unshift(head);
      outerRequest = https.request({
        protocol: 'https:',
        hostname: target.hostname,
        port: Number(target.port) || 443,
        path: target.pathname + target.search,
        method: init.method || 'GET',
        headers: init.headers || {},
        servername: target.hostname,
        socket,
        agent: false,
      }, (response2) => {
        const chunks = [];
        response2.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response2.on('end', () => {
          init.signal?.removeEventListener('abort', abort);
          resolve(new Response(Buffer.concat(chunks), {
            status: response2.statusCode || 500,
            headers: response2.headers,
          }));
        });
        response2.on('error', reject);
      });
      outerRequest.once('error', (error) => {
        init.signal?.removeEventListener('abort', abort);
        reject(error);
      });
      outerRequest.end(init.body);
    });
    connect.once('error', (error) => {
      init.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    connect.end();
  });
}

function settings(min = {}) {
  return {
    enabled: true,
    shadowMode: false,
    baseUrl: String(process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/+$/, ''),
    apiKey: String(process.env.TYPESAFE_API_KEY || ''),
    model: String(process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest'),
    requestTimeoutMs: 20_000,
    maxRetries: 1,
    schemaVersion: 'jev.recallflow.v1',
    maxAttemptsPerRun: 36,
    maxConsecutiveActions: 12,
    maxRepeatedActionsWithoutProgress: 3,
    maxElementCandidates: 40,
    minReadConfidence: 0.6,
    minActionConfidence: 0.8,
    minClickConfidence: 0.86,
    minWaitConfidence: 0.5,
    minTargetOperationConfidence: 0.75,
    ...min,
  };
}

function selectedTarget(bundle, response, operation) {
  const op = bundle.operations[operation];
  const question =
    op?.targetQuestion ||
    (operation === 'CLICK'
      ? JEV_CLICK_TARGET_QUESTION
      : operation === 'TYPE_TEXT'
        ? JEV_TYPE_TEXT_TARGET_QUESTION
        : '');
  if (!question) return null;
  const answer = response.answers[question];
  if (!answer || answer.type !== 'choice') return null;
  const target = bundle.targets[operation]?.[answer.choice] || null;
  return {
    key: answer.choice,
    confidence: answer.confidence,
    label: target?.label || '',
    ref: target?.ref || '',
  };
}

function sampleOutcome(scenario, bundle, response, latencyMs) {
  const operation = response.answers[JEV_OPERATION_QUESTION];
  const actualOperation = operation?.choice || '';
  const target = selectedTarget(bundle, response, actualOperation);
  const expected = scenario.expect;
  return {
    scenario: scenario.id,
    actualOperation,
    operationConfidence: Number(operation?.confidence) || 0,
    operationProbabilities: operation?.probabilities || {},
    target,
    latencyMs,
    correctOperation: actualOperation === expected.operation,
    correctTarget: expected.targetLabel ? target?.label === expected.targetLabel : true,
    accepted: interpretJevFastDecision(response, bundle).kind === 'act',
  };
}

function thresholdScore(samples, thresholds) {
  let correctAccepted = 0;
  let falseAccepted = 0;
  let expectedRejected = 0;
  let ambiguousRejected = 0;
  for (const sample of samples) {
    const scenario = JEV_CALIBRATION_SCENARIOS.find((item) => item.id === sample.scenario);
    const expected = scenario.expect;
    const threshold =
      sample.actualOperation === 'CLICK'
        ? thresholds.minClickConfidence
        : sample.actualOperation === 'TYPE_TEXT'
          ? thresholds.minActionConfidence
          : sample.actualOperation === 'WAIT'
            ? thresholds.minWaitConfidence
            : thresholds.minReadConfidence;
    const targetConfidence = sample.target ? sample.target.confidence : null;
    const operationConfidence = sample.operationConfidence;
    const accepted = targetConfidence == null
      ? operationConfidence >= threshold
      : operationConfidence >= thresholds.minTargetOperationConfidence &&
        targetConfidence >= threshold;
    const correct =
      sample.actualOperation === expected.operation &&
      (!expected.targetLabel || sample.target?.label === expected.targetLabel);
    if (accepted && correct) correctAccepted += 1;
    if (accepted && !correct) falseAccepted += 1;
    if (!accepted && expected.targetLabel) expectedRejected += 1;
    if (!accepted && !expected.targetLabel) ambiguousRejected += 1;
  }
  return { ...thresholds, correctAccepted, falseAccepted, expectedRejected, ambiguousRejected };
}

function sweep(samples) {
  const values = (from, to, step) => {
    const out = [];
    for (let value = from; value <= to + 1e-9; value += step) out.push(Number(value.toFixed(2)));
    return out;
  };
  const results = [];
  for (const minTargetOperationConfidence of values(0.65, 0.85, 0.025)) {
    for (const minClickConfidence of values(0.75, 0.95, 0.025)) {
      for (const minActionConfidence of values(0.7, 0.9, 0.05)) {
        for (const minReadConfidence of values(0.6, 0.8, 0.05)) {
          for (const minWaitConfidence of values(0.35, 0.65, 0.05)) {
            results.push(
              thresholdScore(samples, {
                minTargetOperationConfidence,
                minClickConfidence,
                minActionConfidence,
                minReadConfidence,
                minWaitConfidence,
              })
            );
          }
        }
      }
    }
  }
  return results
    .filter((item) => item.falseAccepted === 0)
    .sort(
      (a, b) =>
        b.correctAccepted - a.correctAccepted ||
        a.expectedRejected - b.expectedRejected ||
        a.minClickConfidence - b.minClickConfidence
    );
}

function summarize(samples) {
  const byScenario = {};
  for (const sample of samples) {
    if (!byScenario[sample.scenario]) byScenario[sample.scenario] = [];
    byScenario[sample.scenario].push(sample);
  }
  return Object.fromEntries(
    Object.entries(byScenario).map(([id, rows]) => {
      const chosen = rows.map((row) => row.actualOperation);
      const targetConf = rows.map((row) => row.target?.confidence).filter(Number.isFinite);
      const opConf = rows.map((row) => row.operationConfidence);
      return [
        id,
        {
          rounds: rows.length,
          operations: chosen,
          operationConfidence: {
            min: Math.min(...opConf),
            max: Math.max(...opConf),
          },
          targetConfidence: targetConf.length
            ? { min: Math.min(...targetConf), max: Math.max(...targetConf) }
            : null,
          correct: rows.filter((row) => row.correctOperation && row.correctTarget).length,
          latencyMs: {
            min: Math.min(...rows.map((row) => row.latencyMs)),
            max: Math.max(...rows.map((row) => row.latencyMs)),
          },
        },
      ];
    })
  );
}

async function main() {
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error('缺少 TYPESAFE_API_KEY；请只在运行环境中设置，不要写入仓库。');
  }
  const rounds = Math.max(1, Math.min(5, Number(process.env.JEV_EVAL_ROUNDS) || 3));
  const samples = [];
  for (const scenario of JEV_CALIBRATION_SCENARIOS) {
    const bundle = buildJevFastRequest(settings(), {
      intent: 'browser_task',
      phase: 'evals',
      instruction: scenario.instruction,
      pageUrl: scenario.snapshot.url,
      pageTitle: scenario.snapshot.title,
      pageText: scenario.snapshot.text,
      snapshot: scenario.snapshot,
    });
    for (let round = 0; round < rounds; round += 1) {
      const started = Date.now();
      const response = await callJevSystemOne(settings(), bundle.request, {
        fetchImpl: proxyAwareFetch,
      });
      samples.push(sampleOutcome(scenario, bundle, response, Date.now() - started));
      process.stdout.write('.');
    }
  }
  process.stdout.write('\n');
  const report = {
    generatedAt: new Date().toISOString(),
    model: settings().model,
    rounds,
    scenarios: JEV_CALIBRATION_SCENARIOS.length,
    samples,
    summary: summarize(samples),
    recommended: sweep(samples).slice(0, 10),
  };
  await fs.mkdir(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'latest-report.json');
  await fs.writeFile(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    report: path.relative(ROOT, outFile),
    summary: report.summary,
    recommended: report.recommended,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
