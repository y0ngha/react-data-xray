import { useEffect, useRef } from 'react';

import { color } from '../theme.js';

/** focus 가 오면 이 줄로 스크롤하고 키보드 포커스를 옮겨 잠깐 강조한다. 줄에 tabIndex={-1} 을 달아 쓴다. */
export const useReveal = (focus: object | undefined) => {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = row.current;
    if (!focus || !el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: 'nearest' });
    el.animate?.([{ backgroundColor: color.border }, { backgroundColor: 'transparent' }], 1500);
  }, [focus]);
  return row;
};
