import { useEffect, useState, type RefObject } from 'react';

/** 요소의 실제 너비. 도킹 방식에 따라 패널 너비가 바뀌므로 ResizeObserver 로 따라간다. */
export const useElementWidth = (ref: RefObject<HTMLElement | null>, fallback: number): number => {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width || fallback));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, fallback]);
  return width;
};
