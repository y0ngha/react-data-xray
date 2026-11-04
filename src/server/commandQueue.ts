import { randomUUID } from 'node:crypto';

import {
  CLI_ACTIVE_MS,
  COMMAND_OPS,
  isCommandOp,
  isReportName,
  isTabId,
  TABS_INDEX,
  type RdxCommand,
  type RdxCommandResult,
} from '../shared/reportPath.js';

/** CLI 가 기다리는 시간을 주지 않았을 때(이전 CLI 등) 받아 가지 않은 명령을 버리는 시간 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 90 * 1000;
/** CLI 가 준 기다리는 시간의 상한. 그 이상은 이 값으로 줄인다 */
export const MAX_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** CLI 의 시간 제한보다 서버가 조금 더 들고 있는다(CLI 가 마지막으로 묻는 사이) */
const TTL_MARGIN_MS = 10 * 1000;
/** 끝난 명령의 결과를 CLI 가 읽을 시간 */
const KEEP_FINISHED_MS = 2 * 60 * 1000;
/** 끝나지 않은 명령도 이보다 오래되면 지운다(탭이 받아 가기만 하고 끝내지 못하는 경우의 상한) */
const MAX_AGE_MS = 60 * 60 * 1000;
/**
 * 이 시간 안에 받아 가기·업로드가 있었던 탭을 연결된 탭으로 본다. CLI·MCP 를 쓰지 않을 때 탭은 1분마다 받아 가고,
 * 오래 가려진 탭은 브라우저가 타이머를 1분에 한 번으로 늦추므로(Chrome 의 intensive throttling) 1분보다 길게 둔다.
 */
export const TAB_LIVE_MS = 75 * 1000;
/** 탭을 고르지 않았을 때, 보이는 탭이 여럿이면 이 시간 안에 포커스를 받은 탭만 고른다. 없으면 고르지 않고 묻는다 */
export const RECENT_FOCUS_MS = 2 * 60 * 1000;
// 한 탭에 쌓아 둘 명령 수. 넘으면 새 명령을 받지 않는다(같은 PC 의 도구가 실수로 반복해 보내는 경우).
const MAX_PENDING = 20;
// 기억하는 탭 수. 넘으면 가장 오래 소식 없는 탭부터 잊는다.
export const MAX_TABS = 50;

export interface LiveTab {
  id: string;
  /** 페이지가 보낸 값이라 믿을 수 없다. 보여 줄 때 다듬는다 */
  path: string;
  title: string;
  /** 마지막으로 받아 가기·업로드가 온 시각(서버 시각, ms) */
  seenAt: number;
  /** 마지막 알림 때 document.visibilityState 가 visible 이었는지 */
  visible: boolean;
  /** 마지막으로 포커스를 받은 시각(서버 시각, ms). 모르면 0 */
  focusedAt: number;
}

export type CommandStatus = 'pending' | 'sent' | 'done' | 'failed' | 'expired';

export interface CommandEntry extends RdxCommand {
  tab: string;
  status: CommandStatus;
  createdAt: number;
  /** 받아 가지 않으면 이 시각에 expired 가 된다(CLI 의 시간 제한 + 여유) */
  expiresAt: number;
  finishedAt?: number;
  error?: string;
}

export interface Store {
  tabs: Map<string, LiveTab>;
  commands: Map<string, CommandEntry>;
  /** 명령 경로의 토큰. dev 서버(프로세스)가 처음 요청을 받을 때 만들어 SERVER_FILE 에 쓴다 */
  token: string;
  /** SERVER_FILE 에 마지막으로 쓴 내용 */
  written?: string;
  /** 브라우저 출처(SERVER_FILE 의 url) */
  origin?: string;
  /** 이 시각까지 CLI·MCP 가 쓰는 중으로 본다 */
  cliActiveUntil: number;
}

// Next dev 는 route 마다 서버 번들을 따로 평가한다(보고서 route 와 명령 route 의 모듈 상태가 다르다). 한 프로세스 안에서는
// 같은 큐와 토큰을 보게 전역에 둔다. 보고서 폴더마다 따로 둔다.
const STORES = Symbol.for('react-data-xray.commandStores');

export const storeFor = (folder: string): Store => {
  const holder = globalThis as { [STORES]?: Map<string, Store> };
  const stores = (holder[STORES] ??= new Map());
  let store = stores.get(folder);
  if (!store) {
    store = { tabs: new Map(), commands: new Map(), token: randomUUID(), cliActiveUntil: 0 };
    stores.set(folder, store);
  }
  return store;
};

const isLive = (store: Store, tab: string, now: number): boolean => {
  const t = store.tabs.get(tab);
  return t !== undefined && now - t.seenAt <= TAB_LIVE_MS;
};

/**
 * 받아 가지 않은 채 시간 제한이 지난 명령, 받아 간 탭이 닫힌(연결이 끊긴) 명령은 expired 로 둔다. 받아 간 탭이 계속
 * 알리는 동안은 오래 걸려도 그대로 둔다(소스맵을 기다리는 snapshot 등). 얼마나 기다릴지는 CLI 의 --timeout 이 정한다.
 */
const prune = (store: Store, now: number): void => {
  store.tabs.forEach((t, id) => now - t.seenAt > TAB_LIVE_MS && store.tabs.delete(id));
  store.commands.forEach((c, id) => {
    if (now - c.createdAt > MAX_AGE_MS || (c.finishedAt !== undefined && now - c.finishedAt > KEEP_FINISHED_MS)) {
      store.commands.delete(id);
      return;
    }
    const lost = c.status === 'sent' && !isLive(store, c.tab, now);
    if ((c.status === 'pending' && now > c.expiresAt) || lost) {
      c.status = 'expired';
      c.finishedAt = now;
      c.error = lost ? 'the tab stopped responding before finishing the command' : 'the tab did not pick up the command in time';
    }
  });
};

export interface TabNotice {
  id: string;
  path: string;
  title: string;
  visible: boolean;
  /** 포커스를 받은 지 몇 ms 지났는지(브라우저 시계와 서버 시계가 달라도 되게 차이로 받는다). 모르면 undefined */
  focusedAgo?: number;
}

/** 탭이 받아 가기·업로드로 열려 있다고 알렸다 */
export const seeTab = (store: Store, { focusedAgo, ...tab }: TabNotice, now: number): void => {
  const prev = store.tabs.get(tab.id);
  store.tabs.delete(tab.id);
  const focusedAt = focusedAgo !== undefined && focusedAgo >= 0 ? now - focusedAgo : (prev?.focusedAt ?? 0);
  store.tabs.set(tab.id, { ...tab, seenAt: now, focusedAt });
  // Map 은 넣은 순서라 앞쪽이 가장 오래 소식 없는 탭이다.
  while (store.tabs.size > MAX_TABS) store.tabs.delete(store.tabs.keys().next().value!);
};

/** 연결된 탭. 최근에 포커스를 받은 것부터 */
export const liveTabs = (store: Store, now: number): LiveTab[] => {
  prune(store, now);
  return [...store.tabs.values()].sort((a, b) => Number(b.visible) - Number(a.visible) || b.focusedAt - a.focusedAt || b.seenAt - a.seenAt);
};

/** CLI·MCP 가 명령 경로를 썼다. 한동안 탭이 5초마다 받아 가게 한다 */
export const markCliActive = (store: Store, now: number): void => {
  store.cliActiveUntil = now + CLI_ACTIVE_MS;
};

export const isCliActive = (store: Store, now: number): boolean => now < store.cliActiveUntil;

/**
 * 탭을 주지 않았을 때 고를 탭. 보이는 탭이 하나면 그 탭, 여럿이면 최근(RECENT_FOCUS_MS 안)에 포커스를 받은 탭 중 가장 최근 것.
 * 보이는 탭이 없으면(창을 내려 둔 경우) 연결된 탭 중에서 같은 규칙으로 고른다. 고를 수 없으면 undefined(묻는다).
 * 짐작해 엉뚱한 탭을 reset 하는 것보다 --tab 을 묻는 편이 낫다.
 */
const pickTab = (tabs: readonly LiveTab[], now: number): LiveTab | undefined => {
  const visible = tabs.filter((t) => t.visible);
  const pool = visible.length ? visible : tabs;
  if (pool.length === 1) return pool[0];
  const recent = pool.filter((t) => t.focusedAt > 0 && now - t.focusedAt <= RECENT_FOCUS_MS);
  return recent.sort((a, b) => b.focusedAt - a.focusedAt)[0];
};

export type CreateResult =
  | { ok: true; command: CommandEntry; others: LiveTab[] }
  | { ok: false; status: number; error: string; reason?: 'no-tab' | 'ambiguous' | 'unknown-tab'; tabs?: LiveTab[] };

const timeoutOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, MAX_COMMAND_TIMEOUT_MS) : DEFAULT_COMMAND_TIMEOUT_MS;

/** CLI 가 보낸 명령을 탭 큐에 넣는다 */
export const createCommand = (store: Store, input: unknown, now: number): CreateResult => {
  const { op, name, tab, timeoutMs } = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  if (!isCommandOp(op)) return { ok: false, status: 400, error: `op must be one of ${COMMAND_OPS.join(', ')}` };
  if (op === 'snapshot' && (typeof name !== 'string' || !isReportName(name)))
    return {
      ok: false,
      status: 400,
      error: "snapshot needs a name of up to 64 letters, digits, ., _ or - (cannot start with . or be 'report')",
    };
  if (tab !== undefined && (typeof tab !== 'string' || !isTabId(tab) || tab === TABS_INDEX))
    return { ok: false, status: 400, error: 'invalid tab id' };
  const tabs = liveTabs(store, now);
  if (!tabs.length) return { ok: false, status: 409, reason: 'no-tab', error: 'no browser tab is connected', tabs };
  const target = tab === undefined ? pickTab(tabs, now) : tabs.find((t) => t.id === tab);
  if (!target)
    return tab === undefined
      ? { ok: false, status: 409, reason: 'ambiguous', error: 'several tabs are open and none was focused recently; pass a tab id', tabs }
      : { ok: false, status: 404, reason: 'unknown-tab', error: `tab ${tab} is not connected`, tabs };
  if ([...store.commands.values()].filter((c) => c.tab === target.id && c.status === 'pending').length >= MAX_PENDING)
    return { ok: false, status: 429, error: 'too many pending commands for this tab' };
  const command: CommandEntry = {
    id: randomUUID(),
    op,
    ...(op === 'snapshot' && { name: name as string }),
    tab: target.id,
    status: 'pending',
    createdAt: now,
    expiresAt: now + timeoutOf(timeoutMs) + TTL_MARGIN_MS,
  };
  store.commands.set(command.id, command);
  return { ok: true, command, others: tabs.filter((t) => t !== target) };
};

/** 이 탭에 맡긴 명령을 꺼내 준다. 꺼낸 명령은 sent 가 되어 다시 주지 않는다 */
export const takeCommands = (store: Store, tab: string, now: number): RdxCommand[] => {
  prune(store, now);
  const out: RdxCommand[] = [];
  store.commands.forEach((c) => {
    if (c.tab !== tab || c.status !== 'pending') return;
    c.status = 'sent';
    out.push({ id: c.id, op: c.op, ...(c.name !== undefined && { name: c.name }) });
  });
  return out;
};

/** 탭이 알린 결과를 적는다. 그 탭에 맡긴, 아직 끝나지 않은 명령만 받는다 */
export const finishCommand = (store: Store, id: string, tab: string, result: unknown, now: number): boolean => {
  prune(store, now);
  const command = store.commands.get(id);
  if (!command || command.tab !== tab || (command.status !== 'sent' && command.status !== 'pending')) return false;
  const { ok, error } = (typeof result === 'object' && result !== null ? result : {}) as Partial<RdxCommandResult>;
  command.status = ok === true ? 'done' : 'failed';
  command.finishedAt = now;
  if (ok !== true) command.error = typeof error === 'string' ? error.slice(0, 500) : 'the tab reported a failure';
  return true;
};

export const getCommand = (store: Store, id: string, now: number): CommandEntry | undefined => {
  prune(store, now);
  return store.commands.get(id);
};
