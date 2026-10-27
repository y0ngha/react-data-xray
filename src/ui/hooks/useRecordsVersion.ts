import { useSyncExternalStore } from 'react';

import { subscribe } from '../../core/requests/store.js';

// 요청이 몰려도 패널은 한 프레임에 한 번만 다시 그린다. 버전 숫자만 구독한다.
let version = 0;

const subscribeFramed = (onChange: () => void): (() => void) => {
  let frame = 0;
  const unsubscribe = subscribe(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      version++;
      onChange();
    });
  });
  return () => {
    cancelAnimationFrame(frame);
    unsubscribe();
  };
};

const getVersion = () => version;

/** 요청 기록이 바뀌면 다시 렌더한다. */
export const useRecordsVersion = (): number => useSyncExternalStore(subscribeFramed, getVersion);
