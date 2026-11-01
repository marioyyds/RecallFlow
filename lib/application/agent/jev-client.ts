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
  if (!raw) throw new JevClientError('CONFIG', '未配置 TypeSafe API 地址');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new JevClientError('CONFIG', 'TypeSafe API 地址格式无效');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new JevClientError('CONFIG', 'TypeSafe API 必须使用 HTTPS（本机开发除外）');
  }
  return url.toString().replace(/\/+$/, '');
}

export function jevSystemOneUrl(settings: Pick<JevSettings, 'baseUrl'>): string {
  return jevBaseUrl(settings) + '/v1/systemone';
}

export function jevModelsUrl(settings: Pick<JevSettings, 'baseUrl'>): string {
  return jevBaseUrl(settings) + '/v1/models';
}

function apiKey(settings: Pick<JevSettings, 'apiKey'>): string {
  const value = String(settings.apiKey || '').trim();
  if (!value) throw new JevClientError('CONFIG', '未配置 TypeSafe API Key');
  return value;
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
        throw new JevClientError('TIMEOUT', 'TypeSafe 请求超时（' + timeoutMs + 'ms）');
      }
      if (attempt < retries) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      throw new JevClientError('NETWORK', 'TypeSafe 连接失败：' + errorMessage(error));
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    }
    if (resp.ok) {
      try {
        return await resp.json();
      } catch {
        throw new JevClientError('PROTOCOL', 'TypeSafe 返回了无效 JSON', resp.status);
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
        'TypeSafe 当前网络区域不可用（HTTP 451）' +
          (detail ? '：' + detail : '') +
          '。请切换可用的网络出口后重试。',
        resp.status
      );
    }
    throw new JevClientError(
      'HTTP',
      'TypeSafe 请求失败 (' + resp.status + ')' + (detail ? '：' + detail : ''),
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
  const raw = await requestJson(settings, jevModelsUrl(settings), {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + apiKey(settings) },
  }, options);
  return parseJevModelList(raw);
}

export async function callJevSystemOne(
  settings: JevSettings,
  request: JevSystemOneRequest,
  options: JevClientOptions = {}
): Promise<JevSystemOneResponse> {
  if (!request.model) {
    throw new JevClientError('CONFIG', '请求缺少 TypeSafe 模型名');
  }
  const body = sanitizeLoneSurrogates(JSON.stringify(request));
  const raw = await requestJson(settings, jevSystemOneUrl(settings), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey(settings),
      'Content-Type': 'application/json',
    },
    body,
  }, options);
  return parseJevSystemOneResponse(raw, request.questions);
}
