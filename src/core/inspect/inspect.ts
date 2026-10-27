import { collectValues } from '../fiber/componentValues.js';
import { getComponentName, getFiber } from '../fiber/tree.js';
import { isComposite, type Fiber } from '../fiber/types.js';
import { findDerivedOrigin } from './derivedMatch.js';
import { findExactOrigins, isSameOrChildPath, type Candidate } from './exactMatch.js';
import { mergeHits } from './mergeHits.js';
import { guessByText } from './textMatch.js';
import type { ComponentResult, Hit, InspectResult } from './types.js';

// styled 래퍼, Tooltip 같은 중간 컴포넌트가 많아 데이터를 가진 컴포넌트까지 꽤 올라가야 한다.
const MAX_COMPONENTS = 60;
const MAX_COMPONENTS_WITH_HITS = 3;
const MAX_DERIVED_HITS = 10;

const derivedHits = (candidates: readonly Candidate[]): Hit[] =>
  candidates
    .map(({ value, where }) => ({ origin: findDerivedOrigin(value), where }))
    .filter((c): c is { origin: NonNullable<ReturnType<typeof findDerivedOrigin>>; where: string } => c.origin !== null)
    .filter(({ origin }, i, all) => all.findIndex((x) => x.origin.record === origin.record && x.origin.path === origin.path) === i)
    .slice(0, MAX_DERIVED_HITS)
    .map(({ origin, where }) => ({ record: origin.record, path: origin.path, via: where, match: 'derived' as const }));

const MAX_EXACT_HITS = 10;

/** 같은 응답 위치(또는 그 하위)를 여러 값에서 들고 있으면 처음 찾은 것만 남긴다(props 가 훅보다 앞선다). */
const uniqueHits = (hits: readonly Hit[]): Hit[] =>
  hits
    .filter((hit, i) => !hits.slice(0, i).some((h) => h.record === hit.record && isSameOrChildPath(hit.path, h.path)))
    .slice(0, MAX_EXACT_HITS);

/** 컴포넌트 하나가 들고 있는 데이터의 출처. 참조로 못 찾으면 필드 값 겹침(파생)으로 찾는다. */
export const inspectFiber = (fiber: Fiber): Hit[] => {
  const found = collectValues(fiber).map(({ via, value, queryKey }) => findExactOrigins(value, via, queryKey));
  const exact = uniqueHits(found.flatMap((f) => f.hits));
  return mergeHits(exact.length > 0 ? exact : derivedHits(found.flatMap((f) => f.candidates)));
};

const ancestorsOf = (fiber: Fiber | null): Fiber[] => (fiber ? [fiber, ...ancestorsOf(fiber.return)] : []);

/** 클릭한 요소에서 위로 올라가며 데이터를 가진 컴포넌트를 3개까지 찾는다. 못 찾으면 화면 글자로 추정한다. */
export const inspect = (el: Element): InspectResult => {
  const components: ComponentResult[] = [];
  for (const fiber of ancestorsOf(getFiber(el)).filter(isComposite).slice(0, MAX_COMPONENTS)) {
    if (components.filter((c) => c.hits.length > 0).length >= MAX_COMPONENTS_WITH_HITS) break;
    components.push({ name: getComponentName(fiber), hits: inspectFiber(fiber) });
  }
  const found = components.some((c) => c.hits.length > 0);
  const text = el.childElementCount === 0 ? (el.textContent ?? '') : '';
  return { components, guesses: found ? [] : guessByText(text) };
};
