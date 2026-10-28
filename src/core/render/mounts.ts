import { getComponentName, jsxLocationOf } from '../fiber/tree.js';
import type { Fiber } from '../fiber/types.js';

export interface MountStats {
  mounts: number;
  unmounts: number;
  /** 같은 부모 아래 같은 이름이 모두 사라졌다가 곧 다시 생긴 횟수(많은 순). parent 는 서브트리를 갈아 끼운 가장 가까운 부모 */
  remounts: Array<{ parent: string; count: number; cause?: 'type-changed' }>;
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
  lastUnmountType?: unknown;
  lastUnmountLocation?: string;
}

interface Stat {
  mounts: number;
  unmounts: number;
  places: Map<string, Place>;
  remounts: Map<string, number>;
  /** 같은 자리에서 이름은 같고 타입 정체만 바뀐 재마운트(렌더 중에 만든 컴포넌트) */
  typeRemounts: Map<string, number>;
}

const stats = new Map<string, Stat>();

const statOf = (name: string): Stat => {
  let s = stats.get(name);
  if (!s) {
    s = { mounts: 0, unmounts: 0, places: new Map(), remounts: new Map(), typeRemounts: new Map() };
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

// memo·forwardRef 래퍼 안의 실제 함수
const functionOf = (type: unknown): object | undefined => {
  if (typeof type === 'function') return type;
  if (!type || typeof type !== 'object') return undefined;
  const wrapped = type as { type?: unknown; render?: unknown };
  return functionOf(wrapped.type ?? wrapped.render);
};

/**
 * 같은 정의에서 다시 만들어진 타입인지: 함수 본문이 같다. 함수를 못 얻는 타입(styled 같은 객체)은 element 의 소스 위치가 같을 때만 같다고 본다.
 * 이름만 같은 다른 컴포넌트나 HMR 이 바꾼 타입은 렌더 중에 만든 것이 아니다.
 */
const sameDefinition = (a: unknown, aAt: string | undefined, b: unknown, bAt: string | undefined): boolean => {
  const fa = functionOf(a);
  const fb = functionOf(b);
  if (fa && fb) return Function.prototype.toString.call(fa) === Function.prototype.toString.call(fb);
  return aAt !== undefined && aAt === bAt;
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
    place.lastUnmountType = r.fiber.type;
    place.lastUnmountLocation = jsxLocationOf(r.fiber);
  });
  mounted.forEach((r) => {
    const s = statOf(getComponentName(r.fiber));
    s.mounts++;
    const place = placeOf(s, nameOf(r.parent));
    const recent = place.lastUnmount !== undefined && now - place.lastUnmount <= REMOUNT_MS;
    const bump = (m: Map<string, number>) => m.set(nameOf(r.branch), (m.get(nameOf(r.branch)) ?? 0) + 1);
    // 타입이 바뀌었으면 형제가 많아도(표의 셀 수백 개) 모두 센다. 아니면 형제가 남아 있는 목록 항목은 재마운트가 아니다.
    const typeChanged =
      recent &&
      place.lastUnmountType !== r.fiber.type &&
      sameDefinition(place.lastUnmountType, place.lastUnmountLocation, r.fiber.type, jsxLocationOf(r.fiber));
    if (typeChanged) bump(s.typeRemounts);
    else if (recent && place.live === 0) bump(s.remounts);
    place.live++;
  });
};

export const getMountStats = (name: string): MountStats => {
  const s = stats.get(name);
  if (!s) return { mounts: 0, unmounts: 0, remounts: [] };
  return {
    mounts: s.mounts,
    unmounts: s.unmounts,
    remounts: [
      ...Array.from(s.remounts, ([parent, count]) => ({ parent, count })),
      ...Array.from(s.typeRemounts, ([parent, count]) => ({ parent, count, cause: 'type-changed' as const })),
    ].sort((a, b) => b.count - a.count),
  };
};

export const resetMounts = (): void => stats.clear();
