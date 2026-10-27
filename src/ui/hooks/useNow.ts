import { useState } from 'react';

import { useInterval } from './useInterval.js';

/** 현재 시각. ms 마다 갱신하고, paused 면 멈춘다. 렌더 중에 Date.now() 를 부르지 않기 위해 쓴다. */
export const useNow = (ms: number, paused = false): number => {
  const [now, setNow] = useState(Date.now);
  useInterval(() => setNow(Date.now()), ms, !paused);
  return now;
};
