import { getComponentName } from '../fiber/tree.js';
import type { Fiber } from '../fiber/types.js';

export interface MountStats {
  mounts: number;
  unmounts: number;
  /** 같은 부모 아래 같은 이름이 모두 사라졌다가 곧 다시 생긴 횟수(많은 순). parent 는 서브트리를 갈아 끼운 가장 가까운 부모 */
  remounts: Array<{ parent: string; count: number }>;
}

/**
 * commit 이 넘기는 참조. parent 는 바로 위 컴포넌트(같은 자리 판정), branch 는 마운트된 서브트리를 새로 만든
 * 가장 가까운 기존 컴포넌트(재마운트 원인으로 보여 줄 부모)다. 없으면 루트.
 */
export interface MountRef {
  fiber: Fiber;
  parent?: Fiber;
  branch?: Fiber;
}

// 언마운트 뒤 이 안에 다시 마운트돼야 재마운트로 본다(느린 로딩 분기도 잡을 만큼)
const REMOUNT_MS = 5000;
const MAX_NAMES = 1000;

interface Place {
  live: number;
  lastUnmount?: number;
}

interface Stat {
  mounts: number;
  unmounts: number;
  places: Map<string, Place>;
  remounts: Map<string, number>;
}

const stats = new Map<string, Stat>();

const statOf = (name: string): Stat => {
  let s = stats.get(name);
  if (!s) {
    s = { mounts: 0, unmounts: 0, places: new Map(), remounts: new Map() };
    stats.set(name, s);
    if (stats.size > MAX_NAMES) stats.delete(stats.keys().next().value as string);
  }
  return s;
};

const placeOf = (s: Stat, parent: string): Place => {
  let p = s.places.get(parent);
  if (!p) s.places.set(parent, (p = { live: 0 }));
  return p;
};

const nameOf = (f?: Fiber): string => (f ? getComponentName(f) : '');

/** 한 commit 의 언마운트를 먼저, 마운트를 나중에 반영한다(key 가 바뀌면 같은 commit 에서 둘 다 일어난다). */
export const recordMounts = (unmounted: readonly MountRef[], mounted: readonly MountRef[], now: number): void => {
  unmounted.forEach((r) => {
    const s = statOf(getComponentName(r.fiber));
    s.unmounts++;
    const place = placeOf(s, nameOf(r.parent));
    place.live = Math.max(0, place.live - 1);
    place.lastUnmount = now;
  });
  mounted.forEach((r) => {
    const s = statOf(getComponentName(r.fiber));
    s.mounts++;
    const place = placeOf(s, nameOf(r.parent));
    // 형제가 남아 있으면(목록 항목) 재마운트가 아니다.
    if (place.live === 0 && place.lastUnmount !== undefined && now - place.lastUnmount <= REMOUNT_MS)
      s.remounts.set(nameOf(r.branch), (s.remounts.get(nameOf(r.branch)) ?? 0) + 1);
    place.live++;
  });
};

export const getMountStats = (name: string): MountStats => {
  const s = stats.get(name);
  if (!s) return { mounts: 0, unmounts: 0, remounts: [] };
  return {
    mounts: s.mounts,
    unmounts: s.unmounts,
    remounts: Array.from(s.remounts, ([parent, count]) => ({ parent, count })).sort((a, b) => b.count - a.count),
  };
};

export const resetMounts = (): void => stats.clear();
