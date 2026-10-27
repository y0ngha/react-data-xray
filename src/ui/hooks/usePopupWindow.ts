import { useCallback, useEffect, useRef, useState } from 'react';

import { color } from '../theme.js';

const POLL_CLOSED_MS = 500;

const openWindow = (): Window | null => {
  const win = window.open('', 'react-data-xray', 'width=960,height=640');
  if (!win) return null;
  win.document.title = 'React Data X-ray';
  Object.assign(win.document.body.style, { margin: '0', background: color.bg });
  return win;
};

/**
 * 도킹 해제용 별도 창. 창은 사용자의 클릭(이벤트 처리기) 안에서 열어야 팝업 차단을 덜 받는다.
 * 창이 막히거나 사용자가 닫으면 onClosed 를 부른다.
 */
export const usePopupWindow = (onClosed: () => void) => {
  const [popup, setPopup] = useState<Window | null>(null);
  const onClosedRef = useRef(onClosed);
  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  const open = useCallback(() => {
    const win = openWindow();
    setPopup(win);
    if (!win) onClosedRef.current();
  }, []);

  const close = useCallback(() => setPopup(null), []);

  // 다른 창의 unload 이벤트는 브라우저마다 다르게 오므로, 닫혔는지 주기적으로 확인한다.
  useEffect(() => {
    if (!popup) return undefined;
    const timer = window.setInterval(() => {
      if (!popup.closed) return;
      setPopup(null);
      onClosedRef.current();
    }, POLL_CLOSED_MS);
    return () => {
      window.clearInterval(timer);
      if (!popup.closed) popup.close();
    };
  }, [popup]);

  return { popup, open, close };
};
