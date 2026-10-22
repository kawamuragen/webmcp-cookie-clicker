import { BUILDINGS, type BuildingId, type GrantId, type ResearchTopic } from './data.ts';

/** localStorage に保存する永続状態 */
export interface GameState {
  version: 1;
  cookies: number;
  lifetime: number;
  clicks: number;
  startedAt: number;
  /** 経過時間（ms）。タブを閉じていた時間は数えない */
  playMs: number;
  goalReachedAtMs: number | null;
  buildings: Record<BuildingId, number>;
  upgrades: string[];
  research: Record<ResearchTopic, number>;
  grants: Record<GrantId, { owned: boolean; enabled: boolean }>;
  /** この額を超える購入は人間の承認が必要（Infinity なら承認不要） */
  approvalLimit: number;
  devMode: boolean;
  stats: {
    toolCalls: number;
    feesPaid: number;
    goldenSeen: number;
    goldenByHuman: number;
    goldenByAgent: number;
    injectionsResisted: number;
    injectionsFallen: number;
    approvalsApproved: number;
    approvalsRejected: number;
    cheats: number;
  };
}

export function createState(now = Date.now()): GameState {
  return {
    version: 1,
    cookies: 0,
    lifetime: 0,
    clicks: 0,
    startedAt: now,
    playMs: 0,
    goalReachedAtMs: null,
    buildings: Object.fromEntries(BUILDINGS.map((b) => [b.id, 0])) as Record<BuildingId, number>,
    upgrades: [],
    research: { click: 0, production: 0, golden: 0 },
    grants: {
      purchase: { owned: false, enabled: false },
      upgrade: { owned: false, enabled: false },
      golden: { owned: false, enabled: false },
      news: { owned: false, enabled: false },
      research: { owned: false, enabled: false },
    },
    approvalLimit: 1_000,
    devMode: false,
    stats: {
      toolCalls: 0,
      feesPaid: 0,
      goldenSeen: 0,
      goldenByHuman: 0,
      goldenByAgent: 0,
      injectionsResisted: 0,
      injectionsFallen: 0,
      approvalsApproved: 0,
      approvalsRejected: 0,
      cheats: 0,
    },
  };
}

const STORAGE_KEY = 'webmcp-cookie-clicker/v1';

export function saveState(state: GameState): void {
  try {
    const approvalLimit = Number.isFinite(state.approvalLimit) ? state.approvalLimit : -1;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, approvalLimit }));
  } catch {
    /* プライベートモード等では保存しない */
  }
}

export function loadState(): GameState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GameState;
    if (parsed.version !== 1) return null;
    const base = createState();
    return {
      ...base,
      ...parsed,
      buildings: { ...base.buildings, ...parsed.buildings },
      research: { ...base.research, ...parsed.research },
      grants: { ...base.grants, ...parsed.grants },
      stats: { ...base.stats, ...parsed.stats },
      approvalLimit: parsed.approvalLimit === -1 ? Infinity : parsed.approvalLimit,
    };
  } catch {
    return null;
  }
}

export function clearSavedState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}
