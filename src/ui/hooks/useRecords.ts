import { startTransition, useEffect, useState } from 'react';

import { getRecords, getStoreVersion, subscribe } from '../../core/requests/store.js';
import type { RequestRecord } from '../../core/requests/types.js';

// 갱신하는 순간의 복사본. 렌더 중에는 store 를 읽지 않아, 급한 렌더가 끼어도 같은 기록으로 그리고 다시 계산하지 않는다.
const copyRecords = (): readonly RequestRecord[] => [...getRecords()];

/** 요청 기록. 바뀌면 한 프레임에 한 번, 낮은 우선순위(transition)로 새 복사본을 받는다. */
export const useRecords = (): readonly RequestRecord[] => {
  const [records, setRecords] = useState(copyRecords);
  // 처음 렌더 때 본 store 버전. effect 에서 구독하기 전에 바뀐 것을 잡는 데 쓴다.
  const [seen] = useState(getStoreVersion);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = copyRecords();
        startTransition(() => setRecords(next));
      });
    };
    const unsubscribe = subscribe(update);
    if (getStoreVersion() !== seen) update();
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [seen]);
  return records;
};
