import { getComponentName, jsxLocationOf, resolveJsxLocation } from '../fiber/tree.js';
import type { Fiber } from '../fiber/types.js';

export interface MountStats {
  mounts: number;
  unmounts: number;
  /** 같은 부모 아래 같은 이름이 모두 사라졌다가 곧 다시 생긴 횟수(많은 순). parent 는 서브트리를 갈아 끼운 가장 가까운 부모 */
  remounts: Array<{ parent: string; count: number; /** 마지막 재마운트 시각 */ lastAt: number; cause?: 'type-changed' }>;
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
  /** 지켜보기 전에 마운트된 인스턴스가 사라져 live 를 믿을 수 없다. 이 자리의 형제 기반 재마운트는 세지 않는다. */
  liveUnknown?: boolean;
}

interface Remount {
  count: number;
  lastAt: number;
}

interface Stat {
  mounts: number;
  unmounts: number;
  places: Map<string, Place>;
  remounts: Map<string, Remount>;
  /** 같은 자리에서 이름은 같고 타입 정체만 바뀐 재마운트(렌더 중에 만든 컴포넌트) */
  typeRemounts: Map<string, Remount>;
}

// 이름 기준 통계와, 같은 이름이 여러 위치에서 렌더될 때 위치별로 보는 통계("이름|위치")
const stats = new Map<string, Stat>();
const statsAt = new Map<string, Stat>();
// React 19 의 위치는 소스맵으로 풀린 뒤 다른 값이 된다. 풀린 위치("이름|원본 위치") → 통계 키
const aliases = new Map<string, string>();

const keyAt = (name: string, at: string | undefined): string => `${name}|${at ?? ''}`;

const statOf = (map: Map<string, Stat>, key: string): Stat => {
  let s = map.get(key);
  if (!s) {
    s = { mounts: 0, unmounts: 0, places: new Map(), remounts: new Map(), typeRemounts: new Map() };
    map.set(key, s);
    if (map.size > MAX_NAMES) map.delete(map.keys().next().value as string);
  }
  return s;
};

/** 이름 통계와 위치 통계, 둘 다에 같은 기록을 한다. */
const statsOf = (fiber: Fiber, at: string | undefined): Stat[] => {
  const name = getComponentName(fiber);
  const key = keyAt(name, at);
  if (at && !statsAt.has(key)) {
    void resolveJsxLocation(fiber)
      .then((resolved) => resolved && resolved !== at && statsAt.has(key) && aliases.set(keyAt(name, resolved), key))
      .catch(() => undefined);
  }
  return [statOf(stats, name), statOf(statsAt, key)];
};

const placeOf = (s: Stat, parent: string): Place => {
  let p = s.places.get(parent);
  if (!p) s.places.set(parent, (p = { live: 0 }));
  return p;
};

// memo 래퍼 안의 실제 함수. forwardRef 의 render 는 styled 같은 라이브러리 컴포넌트가 하나를 공용으로 써서 정의를 가리지 못하므로 벗기지 않는다.
const functionOf = (type: unknown): object | undefined => {
  if (typeof type === 'function') return type;
  if (!type || typeof type !== 'object') return undefined;
  return functionOf((type as { type?: unknown }).type);
};

/**
 * 같은 정의에서 다시 만들어진 타입인지: 함수 본문이 같고 element 의 소스 위치도 같다(위치를 모르면 본문만).
 * 같은 팩토리가 찍어낸 HOC 는 본문이 같아도 다른 컴포넌트이므로 위치로 가른다. 함수를 못 얻는 타입(styled 같은 객체)은 위치가 같을 때만 같다고 본다.
 * 이름만 같은 다른 컴포넌트나 HMR 이 바꾼 타입은 렌더 중에 만든 것이 아니다.
 */
const sameDefinition = (a: unknown, aAt: string | undefined, b: unknown, bAt: string | undefined): boolean => {
  const fa = functionOf(a);
  const fb = functionOf(b);
  if (fa && fb) return Function.prototype.toString.call(fa) === Function.prototype.toString.call(fb) && (!aAt || !bAt || aAt === bAt);
  return aAt !== undefined && aAt === bAt;
};

const nameOf = (f?: Fiber): string => (f ? getComponentName(f) : '');

const bump = (m: Map<string, Remount>, parent: string, now: number): void => {
  const prev = m.get(parent);
  m.set(parent, { count: (prev?.count ?? 0) + 1, lastAt: now });
};

/**
 * 한 commit 의 언마운트를 먼저, 마운트를 나중에 반영한다(key 가 바뀌면 같은 commit 에서 둘 다 일어난다).
 * shortcut: 지켜보기 전(또는 reset 전)에 마운트된 것은 live 를 몰라, 그 자리에서 사라진 인스턴스가 있으면 형제 기반 재마운트를 세지 않는다.
 * 그래서 그 전에 마운트된 단일 컴포넌트의 재마운트는 놓친다(목록 항목 삭제·추가를 재마운트로 세는 것보다 낫다). 지켜보는 동안 처음 마운트된 항목만 있던 자리는 센다.
 */
export const recordMounts = (unmounted: readonly MountRef[], mounted: readonly MountRef[], now: number): void => {
  unmounted.forEach((r) => {
    const at = jsxLocationOf(r.fiber);
    statsOf(r.fiber, at).forEach((s) => {
      s.unmounts++;
      const place = placeOf(s, nameOf(r.parent));
      if (place.live === 0) place.liveUnknown = true;
      else place.live--;
      place.lastUnmount = now;
      place.lastUnmountType = r.fiber.type;
      place.lastUnmountLocation = at;
    });
  });
  mounted.forEach((r) => {
    const at = jsxLocationOf(r.fiber);
    const branch = nameOf(r.branch);
    statsOf(r.fiber, at).forEach((s) => {
      s.mounts++;
      const place = placeOf(s, nameOf(r.parent));
      const recent = place.lastUnmount !== undefined && now - place.lastUnmount <= REMOUNT_MS;
      // 타입이 바뀌었으면 형제가 많아도(표의 셀 수백 개) 모두 센다. 아니면 형제가 남아 있는 목록 항목은 재마운트가 아니다.
      const typeChanged =
        recent &&
        place.lastUnmountType !== r.fiber.type &&
        sameDefinition(place.lastUnmountType, place.lastUnmountLocation, r.fiber.type, at);
      if (typeChanged) bump(s.typeRemounts, branch, now);
      else if (recent && place.live === 0 && !place.liveUnknown) bump(s.remounts, branch, now);
      place.live++;
    });
  });
};

/** 위치를 주면 그 위치에서 렌더된 것만, 없으면 이름 전체를 센다. */
export const getMountStats = (name: string, location?: string): MountStats => {
  const key = keyAt(name, location);
  const s = location === undefined ? stats.get(name) : statsAt.get(aliases.get(key) ?? key);
  if (!s) return { mounts: 0, unmounts: 0, remounts: [] };
  return {
    mounts: s.mounts,
    unmounts: s.unmounts,
    remounts: [
      ...Array.from(s.remounts, ([parent, r]) => ({ parent, ...r })),
      ...Array.from(s.typeRemounts, ([parent, r]) => ({ parent, ...r, cause: 'type-changed' as const })),
    ].sort((a, b) => b.count - a.count),
  };
};

export const resetMounts = (): void => {
  stats.clear();
  statsAt.clear();
  aliases.clear();
};
