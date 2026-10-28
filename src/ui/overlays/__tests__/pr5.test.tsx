import { expect, it } from 'vitest';

import { separateLabels } from '../SourceOverlay.js';

it('separateLabels: 라벨 크기를 모두 읽은 뒤에 위치를 쓴다 (PR5-9, ponytail PR5-9)', () => {
  const log: string[] = [];
  const label = () => {
    const el = document.createElement('button');
    Object.defineProperty(el, 'offsetWidth', { get: () => (log.push('r'), 40) });
    Object.defineProperty(el, 'offsetHeight', { get: () => (log.push('r'), 12) });
    Object.defineProperty(el.style, 'top', { get: () => '', set: () => void log.push('w') });
    return { label: el } as never;
  };
  const rects = [new DOMRect(0, 0, 50, 20), new DOMRect(0, 0, 40, 20), new DOMRect(0, 0, 30, 20)];
  separateLabels([label(), label(), label()], rects);
  // 읽기와 쓰기가 번갈아 나오면 라벨마다 레이아웃을 다시 계산한다.
  expect(log.join('')).toMatch(/^r+w+$/);
  expect(log.filter((l) => l === 'w')).toHaveLength(3);
});
