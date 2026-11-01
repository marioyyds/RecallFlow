// Last JEV outcome, persisted for the settings page. This intentionally keeps
// only routing metadata, never prompts, page text, API keys, or tool results.

export const JEV_DIAGNOSTICS_KEY = 'jevDiagnostics.v1';

export type JevDiagnosticState = 'deciding' | 'shadow' | 'act' | 'handoff' | 'error';

export interface JevDiagnosticRecord {
  updatedAt: number;
  state: JevDiagnosticState;
  mode: 'shadow' | 'live';
  attempts: number;
  outcome: string;
  reason?: string;
  phase?: string;
  tool?: string;
  latencyMs?: number;
  failed?: boolean;
}

interface LocalStorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function defaultStorage(): LocalStorageLike | null {
  const local = (globalThis as any)?.chrome?.storage?.local;
  if (!local || typeof local.get !== 'function' || typeof local.set !== 'function') return null;
  return {
    get: (key: string) => local.get(key),
    set: (items: Record<string, unknown>) => local.set(items),
  };
}

export async function writeJevDiagnostic(
  record: Omit<JevDiagnosticRecord, 'updatedAt'>,
  storage: LocalStorageLike | null = defaultStorage()
): Promise<boolean> {
  if (!storage) return false;
  try {
    await storage.set({
      [JEV_DIAGNOSTICS_KEY]: {
        ...record,
        updatedAt: Date.now(),
      },
    });
    return true;
  } catch {
    // Diagnostics must never affect task execution.
    return false;
  }
}

export async function readJevDiagnostic(
  storage: LocalStorageLike | null = defaultStorage()
): Promise<JevDiagnosticRecord | null> {
  if (!storage) return null;
  try {
    const data = await storage.get(JEV_DIAGNOSTICS_KEY);
    const value = data?.[JEV_DIAGNOSTICS_KEY];
    if (!value || typeof value !== 'object') return null;
    return value as JevDiagnosticRecord;
  } catch {
    return null;
  }
}
