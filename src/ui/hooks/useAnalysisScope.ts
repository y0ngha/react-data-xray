import { useCallback, useMemo, useState } from 'react';

import { isMounted, isWithin } from '../../core/fiber/tree.js';
import type { Fiber } from '../../core/fiber/types.js';
import { inspect, scopeOf } from '../../core/inspect/inspect.js';
import type { Box, InspectResult } from '../../core/inspect/types.js';
import { requestKeyOf } from '../../core/requests/requestKey.js';
import type { Scope } from '../panels/PanelContent.js';
import { narrowAnalysis, type RequestAnalysis } from './useRequestAnalysis.js';

/**
 * 분석 대상(화면 전체, 또는 요소 선택으로 고른 컴포넌트와 그 아래)과, 그 대상으로 좁힌 요청 분석.
 * - pick: 요소를 클릭하면 그 요소의 출처를 구하고, 데이터를 가진 가장 가까운 컴포넌트를 대상으로 삼는다.
 * - 고른 컴포넌트가 화면에서 사라지면(언마운트) 화면 전체로 본다.
 */
export const useAnalysisScope = () => {
  const [result, setResult] = useState<InspectResult | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);

  const pick = useCallback((el: Element) => {
    const picked = inspect(el);
    setResult(picked);
    setScope(scopeOf(picked));
  }, []);
  const clear = useCallback(() => {
    setScope(null);
    setResult(null);
  }, []);

  // 고른 컴포넌트가 사라졌으면 붙잡지 않고 비운다(렌더 중 state 조정: 사라진 하위 트리와 지난 결과를 놓아 준다).
  if (scope && !isMounted(scope.fiber)) {
    setScope(null);
    setResult(null);
  }
  return { result, scope: scope && isMounted(scope.fiber) ? scope : null, pick, clear };
};

/** 관점 탭이 볼 요청: 대상 안의 박스와 클릭한 요소의 출처가 가리키는 요청만 남긴다. 화면 전체면 그대로 */
export const useScopedAnalysis = (
  analysis: RequestAnalysis,
  scope: Scope | null,
  boxes: readonly Box[],
  result: InspectResult | null,
): RequestAnalysis => {
  // 대상 안의 박스와, 클릭한 요소에서 대상까지의 컴포넌트(대상 밖 조상은 빼고) 출처가 가리키는 요청
  const used = scope
    ? [
        ...boxes.map((b) => b.hit.record),
        ...(result?.components ?? []).filter((c) => isWithin(c.fiber as Fiber, scope.fiber)).flatMap((c) => c.hits.map((h) => h.record)),
      ]
    : [];
  // 박스 배열은 수집마다 새로 만들어지므로, 쓰는 요청(키)이 그대로면 다시 계산하지 않는다.
  const usedKeys = Array.from(new Set(used.map(requestKeyOf)))
    .sort()
    .join('\n');
  return useMemo(
    () => (scope ? narrowAnalysis(analysis, new Set(usedKeys.split('\n').filter(Boolean))) : analysis),
    [analysis, scope, usedKeys],
  );
};
