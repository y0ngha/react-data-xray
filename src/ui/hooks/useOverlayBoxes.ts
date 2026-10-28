import { startTransition, useEffect, useState } from 'react';

import { collectBoxes } from '../../core/inspect/boxes.js';
import { isIndexPending } from '../../core/inspect/derivedMatch.js';
import type { Box } from '../../core/inspect/types.js';
import { enqueue } from '../../core/scheduler/idleQueue.js';
import { subscribeCommits } from '../../core/render/monitor.js';
import type { Fiber } from '../../core/fiber/types.js';
import { isOwnUi } from '../ownUi.js';
import { useRenderMonitoring } from './useRenderMonitoring.js';

// 트리 전체를 훑는 일이라, commit 이 몰려도(폴링 화면) 이 간격에 한 번만 한다.
const COLLECT_MS = 1000;
// 한 번에 쓰는 파생 조회 시간. 넘기면 같은 step 이 다음 큐 조각에서 이어 한다.
const BUDGET_MS = 4;
// deferred 로 같은 step 을 이어 하는 최대 횟수.
const MAX_TRIES = 50;

const NO_BOXES: Box[] = [];

/**
 * 분석 대상(화면 전체, 또는 고른 컴포넌트 안)에서 데이터 출처가 있는 컴포넌트 박스 목록. 렌더 commit 이 있을 때 다시 모은다.
 * 화면 박스 표시뿐 아니라 데이터·네트워크 관점도 이 목록을 쓴다.
 * 스크롤·크기 변경에 따른 위치는 목록을 다시 모으지 않고 그리는 쪽에서 직접 고친다.
 */
export const useOverlayBoxes = (enabled: boolean, scope: Fiber | null): Box[] => {
  // 어느 범위에서 모은 박스인지 함께 둔다. 범위가 바뀐 직후 다음 수집 전까지 이전 범위의 박스를 쓰지 않게 한다.
  const [collected, setCollected] = useState<{ scope: Fiber | null; boxes: Box[] }>({ scope: null, boxes: NO_BOXES });
  // commit 을 받으려면 렌더 감시가 켜져 있어야 한다.
  useRenderMonitoring(enabled);
  useEffect(() => {
    if (!enabled) return undefined;
    let timer = 0;
    let last = 0;
    let cancelled = false;
    let inflight = false; // 큐에 step 이 있는 동안 두 번째 step 을 넣지 않는다
    let dirty = false;
    let tries = 0;
    const collect = () => {
      timer = 0;
      inflight = true;
      dirty = false;
      tries = 0;
      enqueue(step);
    };
    // 덜 모았으면 다음 조각을 큐 뒤에 다시 넣는다. 큐 머리를 붙잡으면 뒤의 분석·알림이 그만큼 밀린다.
    const step = (): boolean => {
      if (cancelled) return true;
      let result: ReturnType<typeof collectBoxes>;
      try {
        result = collectBoxes(isOwnUi, BUDGET_MS, scope ?? undefined);
      } catch {
        // 던져도 inflight 가 남아 다시는 모으지 않는 일이 없게 하고, 그사이 들어온 commit 은 다시 모은다.
        inflight = false;
        if (dirty) schedule();
        return true;
      }
      const { boxes: next, deferred } = result;
      // 트리가 계속 바뀌어 끝나지 않아도 무한히 잇지 않는다(직전 결과로 반영).
      if (deferred && ++tries < MAX_TRIES) {
        enqueue(step);
        return true;
      }
      inflight = false;
      last = Date.now();
      if (dirty) schedule();
      startTransition(() => setCollected({ scope, boxes: next }));
      // 상한에 걸려 덜 모은 채면 commit 이 없어도 평소 간격 뒤에 다시 모은다.
      if (deferred && !timer) timer = window.setTimeout(collect, COLLECT_MS);
      // 응답 색인이 덜 끝났으면 commit 이 없어도 평소 간격 뒤에 한 번 더 모은다(색인 뒤에야 찾는 파생 출처).
      if (isIndexPending() && !timer) timer = window.setTimeout(collect, COLLECT_MS);
      return true;
    };
    const schedule = () => {
      if (inflight) {
        dirty = true;
        return;
      }
      if (!timer) timer = window.setTimeout(collect, Math.max(0, last + COLLECT_MS - Date.now()));
    };
    schedule();
    const unsubscribe = subscribeCommits(schedule);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, scope]);
  return enabled && collected.scope === scope ? collected.boxes : NO_BOXES;
};
