import { useCallback } from 'react';

import { useStoredState } from './useStoredState.js';

/** float: 버튼 옆 작은 패널 · bottom/right: 화면 가장자리에 도킹 · window: 별도 창(도킹 해제) */
export type Dock = 'float' | 'bottom' | 'right' | 'window';

export interface DockSettings {
  dock: Dock;
  bottomHeight: number;
  rightWidth: number;
  /** 사용자가 도킹 방식을 직접 골랐다(앱 모달을 피해 자동으로 옮기지 않는다). */
  chosen?: boolean;
}

const DOCK_KEY = 'react-data-xray:dock';
const DOCKS: ReadonlySet<unknown> = new Set<Dock>(['float', 'bottom', 'right', 'window']);
export const DEFAULT_DOCK: DockSettings = { dock: 'float', bottomHeight: 320, rightWidth: 520 };
// ResizeHandle 의 MIN_SIZE 와 맞춘다. 저장된 값이 더 작으면 최소값으로 올려 도구 막대가 읽히게 한다.
export const MIN_PANEL_SIZE = 260;

const clampSize = (s: DockSettings): DockSettings => ({
  ...s,
  bottomHeight: Math.max(MIN_PANEL_SIZE, s.bottomHeight),
  rightWidth: Math.max(MIN_PANEL_SIZE, s.rightWidth),
});

const parse = (raw: unknown): DockSettings | undefined => {
  const saved = raw as Partial<DockSettings> | null;
  // chosen 이 없던 때 저장한 float 이 아닌 도킹은 사용자가 고른 것이다. float 은 기본값이라 모달과 겹칠 때만 옮긴다.
  return saved && DOCKS.has(saved.dock)
    ? clampSize({ ...DEFAULT_DOCK, ...saved, chosen: saved.chosen ?? saved.dock !== 'float' })
    : undefined;
};

/** 패널을 어떻게 보여 줄지(도킹 방식과 크기). 고른 설정을 기억한다. */
export const useDockSettings = () => {
  const [settings, setSettings, save] = useStoredState(DOCK_KEY, parse, () => DEFAULT_DOCK);
  const update = useCallback(
    (patch: Partial<DockSettings>, options?: { persist?: boolean }) => setSettings((prev) => ({ ...prev, ...patch }), options),
    [setSettings],
  );
  return { settings, update, save };
};
