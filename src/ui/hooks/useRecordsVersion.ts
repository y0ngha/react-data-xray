import { startTransition, useEffect, useState } from 'react';

import { getStoreVersion, subscribe } from '../../core/requests/store.js';

/** 요청 기록이 바뀌면 다시 렌더한다. 한 프레임에 한 번, 낮은 우선순위(transition)로 갱신한다. */
export const useRecordsVersion = (): number => {
  const [version, setVersion] = useState(0);
  // 렌더 때 본 store 버전. effect 에서 구독하기 전에 바뀐 것을 잡는 데 쓴다.
  const [seen] = useState(getStoreVersion);
  useEffect(() => {
    let frame = 0;
    const bump = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        startTransition(() => setVersion((v) => v + 1));
      });
    };
    const unsubscribe = subscribe(bump);
    if (getStoreVersion() !== seen) bump();
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [seen]);
  return version;
};
