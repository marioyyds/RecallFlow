import type { JevSettings } from '../../shared/settings.ts';
import { sanitizeLoneSurrogates } from '../../shared/surrogates.ts';
import {
  type JevModelList,
  type JevSystemOneRequest,
  type JevSystemOneResponse,
  parseJevModelList,
  parseJevSystemOneResponse,
} from './jev-contract.ts';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type FetchImpl = FetchLike | typeof fetch;

export interface JevClientOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
}

export interface JevConnectionProbe {
  models: JevModelList;
  modelListed: boolean;
  systemOneVerified: boolean;
}

export class JevClientError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'JevClientError';
    this.code = code;
    this.status = status;
  }
}

export function jevBaseUrl(settings: Pick<JevSettings, 'baseUrl'>): string {
  const raw = String(settings.baseUrl || '').trim();
  if (!raw) throw new JevClientError('CONFIG', '未配置 JEV API 地址');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new JevClientError('CONFIG', 'JEV API 地址格式无效');
  }
  url.search = '';
  url.hash = '';
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new JevClientError('CONFIG', 'JEV API 必须使用 HTTPS（本机开发除外）');
  }
  return url.toString().replace(/\/+$/, '');
}

export function jevSystemOneUrl(settings: Pick<JevSettings, 'baseUrl'>): string {
  const base = jevBaseUrl(settings);
  const path = new URL(base).pathname.replace(/\/+$/, '');
  // 支持四类常见填法：
  //   https://host
  //   https://host/v1
  //   https://host/compatible-mode/v1
  //   https://host/compatible-mode/v1/systemone（完整推理地址）
  if (/\/systemone$/i.test(path)) return base;
  if (/\/v1$/i.test(path)) return base + '/systemone';
  if (/\/compatible-mode$/i.test(path)) return base + '/v1/systemone';
  return base + '/v1/systemone';
}

export function jevModelsUrl(settings: Pick<JevSettings, 'baseUrl'>): string {
  return jevSystemOneUrl(settings).replace(/\/systemone\/?$/i, '/models');
}

function apiKey(settings: Pick<JevSettings, 'apiKey'>): string {
  const value = String(settings.apiKey || '').trim();
  if (!value) throw new JevClientError('CONFIG', '未配置 JEV API Key');
  return value;
}

/**
 * DASHSCOPE 的 systemone curl 直接使用原始 token：
 *   Authorization: $DASHSCOPE_API_KEY
 * TypeSafe 则要求 Bearer。按 provider endpoint 区分，避免用户粘错时二次加
 * Bearer；如果用户已经把 scheme 写进 key，也原样透传。
 */
export function jevAuthorizationHeader(
  settings: Pick<JevSettings, 'baseUrl' | 'apiKey'>,
  targetUrl = jevSystemOneUrl(settings)
): string {
  const key = apiKey(settings);
  if (/^Bearer\s+/i.test(key)) return key;
  let url: URL | null = null;
  try {
    url = new URL(targetUrl);
  } catch {}
  const rawScheme =
    Boolean(url && /(?:^|\.)aliyuncs\.com$/i.test(url.hostname)) ||
    /\/compatible-mode(?:\/|$)/i.test(url?.pathname || '');
  return rawScheme ? key : 'Bearer ' + key;
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function makeAbortError(): Error {
  const error = new Error('任务已取消');
  error.name = 'AbortError';
  return error;
}

async function readErrorDetail(resp: Response): Promise<string> {
  let raw = '';
  try {
    raw = await resp.text();
  } catch {}
  const value = raw.trim();
  if (!value) return '';
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const detail = parsed.detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object') return JSON.stringify(detail);
    if (typeof parsed.error === 'object' && parsed.error && 'message' in parsed.error) {
      return String((parsed.error as Record<string, unknown>).message || '');
    }
  } catch {}
  return value.slice(0, 1000);
}

async function requestJson(
  settings: JevSettings,
  url: string,
  init: RequestInit,
  options: JevClientOptions = {}
): Promise<unknown> {
  const fetchImpl = (options.fetchImpl || fetch) as FetchLike;
  const external = options.signal;
  const retries = Math.max(0, Math.min(3, Math.floor(Number(settings.maxRetries) || 0)));
  for (let attempt = 0; ; attempt += 1) {
    if (external && external.aborted) throw makeAbortError();
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (external) external.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = Math.max(1000, Math.min(120000, Number(settings.requestTimeoutMs) || 15000));
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let resp: Response;
    try {
      resp = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (external && external.aborted) throw makeAbortError();
      if (timedOut) {
        throw new JevClientError('TIMEOUT', 'JEV 请求超时（' + timeoutMs + 'ms）');
      }
      if (attempt < retries) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      throw new JevClientError('NETWORK', 'JEV 连接失败：' + errorMessage(error));
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    }
    if (resp.ok) {
      try {
        return await resp.json();
      } catch {
        throw new JevClientError('PROTOCOL', 'JEV 服务返回了无效 JSON', resp.status);
      }
    }
    const detail = await readErrorDetail(resp);
    if (attempt < retries && retryableStatus(resp.status)) {
      await sleep(500 * Math.pow(2, attempt));
      continue;
    }
    if (resp.status === 451) {
      throw new JevClientError(
        'REGION_BLOCKED',
        'JEV 当前网络区域不可用（HTTP 451）' +
          (detail ? '：' + detail : '') +
          '。请切换可用的网络出口后重试。',
        resp.status
      );
    }
    throw new JevClientError(
      'HTTP',
      'JEV 请求失败 (' + resp.status + ')' + (detail ? '：' + detail : ''),
      resp.status
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function listJevModels(
  settings: JevSettings,
  options: JevClientOptions = {}
): Promise<JevModelList> {
  const endpoint = jevModelsUrl(settings);
  const raw = await requestJson(settings, endpoint, {
    method: 'GET',
    headers: { Authorization: jevAuthorizationHeader(settings, endpoint) },
  }, options);
  return parseJevModelList(raw);
}

export async function callJevSystemOne(
  settings: JevSettings,
  request: JevSystemOneRequest,
  options: JevClientOptions = {}
): Promise<JevSystemOneResponse> {
  if (!request.model) {
    throw new JevClientError('CONFIG', '请求缺少 JEV 模型名');
  }
  const body = sanitizeLoneSurrogates(JSON.stringify(request));
  const endpoint = jevSystemOneUrl(settings);
  const raw = await requestJson(settings, endpoint, {
    method: 'POST',
    headers: {
      Authorization: jevAuthorizationHeader(settings, endpoint),
      'Content-Type': 'application/json',
    },
    body,
  }, options);
  return parseJevSystemOneResponse(raw, request.questions);
}

/**
 * 连接检测分两段：
 *   1. `/models` 验证 endpoint 与认证；
 *   2. 某些专用 systemone 模型（例如 decision-model-preview）不会出现在
 *      通用模型目录中，因此未列出时再用一个最小 noul 请求验证实际路由。
 * 只有 System One 探测也失败，才判定当前模型不可用。
 */
export async function probeJevConnection(
  settings: JevSettings,
  options: JevClientOptions = {}
): Promise<JevConnectionProbe> {
  const models = await listJevModels(settings, options);
  const modelListed = models.models.some((item) => item.name === settings.model);
  if (modelListed) {
    return { models, modelListed: true, systemOneVerified: false };
  }
  await callJevSystemOne(settings, {
    model: settings.model,
    state: {
      purpose: 'recallflow_connection_probe',
      ts: Date.now(),
    },
    questions: {
      reachable: {
        type: 'noul',
        instructions: 'Is this endpoint responding to a structured System One request?',
      },
    },
  }, options);
  return { models, modelListed: false, systemOneVerified: true };
}
