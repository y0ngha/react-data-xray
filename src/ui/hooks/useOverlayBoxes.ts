import { useEffect, useState } from 'react';

import { collectBoxes } from '../../core/inspect/boxes.js';
import type { Box } from '../../core/inspect/types.js';
import { subscribeCommits } from '../../core/render/monitor.js';
import { isOwnUi } from '../ownUi.js';

const REFRESH_MS = 1000;

/**
 * 전체 표시 박스. 스크롤·크기 변경·렌더 commit·1초마다 다시 계산하되,
 * 이벤트가 몰려도 한 프레임에 한 번만 계산한다.
 */
export const useOverlayBoxes = (): Box[] => {
  const [boxes, setBoxes] = useState<Box[]>([]);
  useEffect(() => {
    let frame = 0;
    const refresh = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setBoxes(collectBoxes(isOwnUi));
      });
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    const unsubscribe = subscribeCommits(refresh);
    window.addEventListener('scroll', refresh, true);
    window.addEventListener('resize', refresh);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      unsubscribe();
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('resize', refresh);
    };
  }, []);
  return boxes;
};
