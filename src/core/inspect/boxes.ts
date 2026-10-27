import { componentRect, findRootFibers, getComponentName, walkFibers } from '../fiber/tree.js';
import { isComposite, type Fiber } from '../fiber/types.js';
import { getOrigin } from '../requests/origins.js';
import { findDerivedOrigin } from './derivedMatch.js';
import type { Box, Hit } from './types.js';

const MAX_BOXES = 500;

const isPlainChild = (key: string, value: unknown): value is object =>
  key !== 'children' && value !== null && typeof value === 'object' && !Array.isArray(value) && !(value as { $$typeof?: unknown }).$$typeof;

/** props 에 응답 객체(배열 제외)를 직접 받는지. 목록의 행, 카드처럼 화면 단위와 맞는다. */
const directPropHit = (fiber: Fiber): Hit | null => {
  const props = fiber.memoizedProps;
  if (!props || typeof props !== 'object') return null;
  const entries = Object.entries(props).filter((entry): entry is [string, object] => isPlainChild(entry[0], entry[1]));
  const exact = entries.map(([k, v]) => ({ k, origin: getOrigin(v) })).find((e) => e.origin);
  if (exact?.origin) return { record: exact.origin.record, path: exact.origin.path, via: `props.${exact.k}`, match: 'exact' };
  const derived = entries.map(([k, v]) => ({ k, origin: findDerivedOrigin(v) })).find((e) => e.origin);
  return derived?.origin ? { record: derived.origin.record, path: derived.origin.path, via: `props.${derived.k}`, match: 'derived' } : null;
};

const sameHit = (a: Hit | null, b: Hit) => !!a && a.record === b.record && a.path === b.path;

/** 화면의 모든 컴포넌트 중 응답 객체를 props 로 직접 받는 것마다 박스를 만든다. */
export const collectBoxes = (isOwnUi: (el: Element) => boolean): Box[] => {
  const boxes: Box[] = [];
  const visit = (fiber: Fiber | null, parentHit: Hit | null): void =>
    walkFibers(fiber, (f) => {
      if (boxes.length >= MAX_BOXES) return false;
      const own = isComposite(f) ? directPropHit(f) : null;
      // 부모와 같은 객체를 그대로 넘겨받은 래퍼 컴포넌트는 박스를 또 그리지 않는다.
      const isNew = own && !sameHit(parentHit, own);
      const rect = isNew ? componentRect(f, isOwnUi) : null;
      if (own && rect) boxes.push({ id: boxes.length, rect, name: getComponentName(f), hit: own, fiber: f });
      visit(f.child, isNew ? own : parentHit);
      return false;
    });
  findRootFibers().forEach((root) => visit(root.child, null));
  return boxes;
};
