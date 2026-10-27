import { useEffect, useRef, useState } from 'react';

import { isOwnUi } from '../ownUi.js';

/**
 * Chrome DevTools 의 요소 선택(Cmd+Shift+C)처럼 동작한다.
 * active 인 동안 호버한 요소의 사각형을 돌려주고, 클릭하면 onPick 을 부른다(앱의 클릭은 막는다).
 */
export const useElementPicker = (active: boolean, onPick: (el: Element) => void): DOMRect | null => {
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    if (!active) return undefined;
    const target = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      return el && !isOwnUi(el) ? el : null;
    };
    const onMove = (e: MouseEvent) => setHoverRect(target(e)?.getBoundingClientRect() ?? null);
    // 캡처 단계에서 막아 앱의 클릭 핸들러가 실행되지 않게 한다.
    const onClick = (e: MouseEvent) => {
      const el = target(e);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      onPickRef.current(el);
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      setHoverRect(null);
    };
  }, [active]);

  return active ? hoverRect : null;
};
