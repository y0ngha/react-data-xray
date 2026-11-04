import { randomUUID } from 'node:crypto';

import { COMMAND_OPS, isReportName, isTabId, type CommandOp, type RdxCommand, type RdxCommandResult } from '../shared/reportPath.js';

/**
 * 탭이 받아 가지 않은 명령은 이만큼 지나면 버린다. 탭은 5초마다 받아 가지만, 오래 가려진 탭은 브라우저가 타이머를
 * 1분에 한 번으로 늦추므로(Chrome 의 intensive throttling) 1분보다 조금 길게 둔다.
 */
export const COMMAND_TTL_MS = 90 * 1000;
/** 이 시간 안에 받아 가기·업로드가 있었던 탭을 연결된 탭으로 본다. 가려진 탭의 1분 주기도 들어오게 한다 */
export const TAB_LIVE_MS = 75 * 1000;
// 한 탭에 쌓아 둘 명령 수. 넘으면 새 명령을 받지 않는다(같은 PC 의 도구가 실수로 반복해 보내는 경우).
const MAX_PENDING = 20;

export interface LiveTab {
  id: string;
  path: string;
  title: string;
  /** 마지막으로 받아 가기·업로드가 온 시각(ms) */
  seenAt: number;
  /** 보고서가 바뀌어 올라온 마지막 시각(ms). 탭을 고르지 않았을 때 사용자가 만지는 탭을 고르는 데 쓴다 */
  activeAt: number;
}

export type CommandStatus = 'pending' | 'sent' | 'done' | 'failed' | 'expired';

export interface CommandEntry extends RdxCommand {
  tab: string;
  status: CommandStatus;
  createdAt: number;
  error?: string;
}

interface Store {
  tabs: Map<string, LiveTab>;
  commands: Map<string, CommandEntry>;
  /** 마지막으로 .server.json 에 쓴 출처 */
  origin?: string;
}

// Next dev 는 route 마다 서버 번들을 따로 평가한다(보고서 route 와 명령 route 의 모듈 상태가 다르다). 한 프로세스 안에서는
// 같은 큐를 보게 전역에 둔다. 보고서 폴더마다 따로 둔다.
const STORES = Symbol.for('react-data-xray.commandStores');

export const storeFor = (folder: string): Store => {
  const holder = globalThis as { [STORES]?: Map<string, Store> };
  const stores = (holder[STORES] ??= new Map());
  let store = stores.get(folder);
  if (!store) {
    store = { tabs: new Map(), commands: new Map() };
    stores.set(folder, store);
  }
  return store;
};

/** 받아 가지 않은 채 TTL 이 지난 명령은 expired 로 두고, 그 뒤 TTL 이 더 지나면(CLI 가 결과를 읽을 시간) 지운다. */
const prune = (store: Store, now: number): void => {
  store.commands.forEach((c, id) => {
    const age = now - c.createdAt;
    if (age > 2 * COMMAND_TTL_MS) store.commands.delete(id);
    else if (age > COMMAND_TTL_MS && (c.status === 'pending' || c.status === 'sent')) {
      c.status = 'expired';
      c.error = 'the tab did not run the command in time';
    }
  });
  store.tabs.forEach((t, id) => now - t.seenAt > TAB_LIVE_MS && store.tabs.delete(id));
};

/** 탭이 받아 가기·업로드로 열려 있다고 알렸다. changed 면 보고서가 바뀐 것이다 */
export const seeTab = (store: Store, tab: Omit<LiveTab, 'seenAt' | 'activeAt'>, changed: boolean, now: number): void => {
  const prev = store.tabs.get(tab.id);
  store.tabs.set(tab.id, { ...tab, seenAt: now, activeAt: changed ? now : (prev?.activeAt ?? 0) });
};

/** 연결된 탭. 사용자가 만진 지 오래되지 않은 것부터 */
export const liveTabs = (store: Store, now: number): LiveTab[] => {
  prune(store, now);
  return [...store.tabs.values()].sort((a, b) => b.activeAt - a.activeAt || b.seenAt - a.seenAt);
};

export type CreateResult =
  | { ok: true; command: CommandEntry; others: LiveTab[] }
  | { ok: false; status: number; error: string; tabs?: LiveTab[] };

const isOp = (op: unknown): op is CommandOp => (COMMAND_OPS as readonly unknown[]).includes(op);

/**
 * CLI 가 보낸 명령을 탭 큐에 넣는다. tab 을 주지 않으면 연결된 탭 중 가장 최근에 보고서가 바뀐 탭(사용자가 만지는 탭)에 넣고,
 * 나머지 탭을 알려 준다. 여러 탭이면 거절하는 안도 봤지만, 닫힌 탭이 TAB_LIVE_MS 동안 남아 새 탭을 열 때마다 거절되므로 고른다.
 */
export const createCommand = (store: Store, input: unknown, now: number): CreateResult => {
  const { op, name, tab } = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  if (!isOp(op)) return { ok: false, status: 400, error: `op must be one of ${COMMAND_OPS.join(', ')}` };
  if (op === 'snapshot' && (typeof name !== 'string' || !isReportName(name)))
    return {
      ok: false,
      status: 400,
      error: "snapshot needs a name of up to 64 letters, digits, ., _ or - (cannot start with . or be 'report')",
    };
  if (tab !== undefined && (typeof tab !== 'string' || !isTabId(tab))) return { ok: false, status: 400, error: 'invalid tab id' };
  const tabs = liveTabs(store, now);
  const target = tab === undefined ? tabs[0] : tabs.find((t) => t.id === tab);
  if (!target)
    return tab === undefined
      ? { ok: false, status: 409, error: 'no browser tab is connected', tabs }
      : { ok: false, status: 404, error: `tab ${tab} is not connected`, tabs };
  if ([...store.commands.values()].filter((c) => c.tab === target.id && c.status === 'pending').length >= MAX_PENDING)
    return { ok: false, status: 429, error: 'too many pending commands for this tab' };
  const command: CommandEntry = {
    id: randomUUID(),
    op,
    ...(op === 'snapshot' && { name: name as string }),
    tab: target.id,
    status: 'pending',
    createdAt: now,
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
  if (ok !== true) command.error = typeof error === 'string' ? error.slice(0, 500) : 'the tab reported a failure';
  return true;
};

export const getCommand = (store: Store, id: string, now: number): CommandEntry | undefined => {
  prune(store, now);
  return store.commands.get(id);
};
