import { useEffect, useRef } from 'react';

/** enabled 인 동안 ms 마다 callback 을 부른다. callback 은 최신 것을 쓴다. */
export const useInterval = (callback: () => void, ms: number, enabled = true): void => {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(() => latest.current(), ms);
    return () => window.clearInterval(timer);
  }, [ms, enabled]);
};
