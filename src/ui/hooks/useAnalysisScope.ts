import { useCallback, useMemo, useState } from 'react';

import { isMounted } from '../../core/fiber/tree.js';
import { inspect, scopeOf } from '../../core/inspect/inspect.js';
import type { Box, InspectResult } from '../../core/inspect/types.js';
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

  return { result, scope: scope && isMounted(scope.fiber) ? scope : null, pick, clear };
};

/** 관점 탭이 볼 요청: 대상 안의 박스와 클릭한 요소의 출처가 가리키는 요청만 남긴다. 화면 전체면 그대로 */
export const useScopedAnalysis = (
  analysis: RequestAnalysis,
  scope: Scope | null,
  boxes: readonly Box[],
  result: InspectResult | null,
): RequestAnalysis =>
  useMemo(() => {
    if (!scope) return analysis;
    const hits = [...boxes.map((b) => b.hit), ...(result?.components.flatMap((c) => c.hits) ?? [])];
    return narrowAnalysis(analysis, new Set(hits.map((h) => h.record)));
  }, [analysis, scope, boxes, result]);
