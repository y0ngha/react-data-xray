import { useEffect, useState } from 'react';

import { collectBoxes } from '../../core/inspect/boxes.js';
import { isIndexPending } from '../../core/inspect/derivedMatch.js';
import type { Box } from '../../core/inspect/types.js';
import { subscribeCommits } from '../../core/render/monitor.js';
import { isOwnUi } from '../ownUi.js';

// 트리 전체를 훑는 일이라, commit 이 몰려도(폴링 화면) 이 간격에 한 번만 한다.
const COLLECT_MS = 1000;
// 한 번에 쓰는 파생 조회 시간. 넘기면 남은 것은 바로 다음 수집에서 이어 한다(한 프레임 안에 끝나도록).
const BUDGET_MS = 12;
const CONTINUE_MS = 50;

/**
 * 전체 표시 박스 목록. 렌더 commit 이 있을 때 다시 모은다.
 * 스크롤·크기 변경에 따른 위치는 목록을 다시 모으지 않고 그리는 쪽에서 직접 고친다.
 */
export const useOverlayBoxes = (): Box[] => {
  const [boxes, setBoxes] = useState<Box[]>([]);
  useEffect(() => {
    let timer = 0;
    let last = 0;
    const collect = () => {
      timer = 0;
      last = Date.now();
      const { boxes: next, deferred } = collectBoxes(isOwnUi, BUDGET_MS);
      setBoxes(next);
      if (deferred) timer = window.setTimeout(collect, CONTINUE_MS);
      // 응답 색인이 덜 끝났으면 commit 이 없어도 평소 간격 뒤에 한 번 더 모은다(색인 뒤에야 찾는 파생 출처).
      else if (isIndexPending()) timer = window.setTimeout(collect, COLLECT_MS);
    };
    const schedule = () => {
      if (!timer) timer = window.setTimeout(collect, Math.max(0, last + COLLECT_MS - Date.now()));
    };
    schedule();
    const unsubscribe = subscribeCommits(schedule);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);
  return boxes;
};
