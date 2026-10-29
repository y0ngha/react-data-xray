import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 성공 알림은 timeoutMs 뒤 자동 지운다; persist=true(실패)면 다음 호출 때까지 유지한다.
 * 언마운트 시 타이머를 정리해 setState 경고를 막는다.
 */
export const useFlash = (timeoutMs: number): [string, (msg: string, persist?: boolean) => void] => {
  const [flash, setFlash] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const set = useCallback(
    (msg: string, persist = false) => {
      clearTimeout(timer.current);
      setFlash(msg);
      if (msg && !persist) {
        timer.current = setTimeout(() => setFlash(''), timeoutMs);
      }
    },
    [timeoutMs],
  );

  useEffect(() => () => clearTimeout(timer.current), []);
  return [flash, set];
};
