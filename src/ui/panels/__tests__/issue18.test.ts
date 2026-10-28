import { describe, expect, it } from 'vitest';

import { dockAvoiding } from '../panelLayout.js';

const rect = (x: number, y: number, w: number, h: number) => new DOMRect(x, y, w, h);
const viewport = rect(0, 0, 1400, 900);

describe('dockAvoiding', () => {
  it('모달이 위쪽에 있으면 아래 도킹', () => {
    expect(dockAvoiding(rect(500, 50, 400, 400), viewport)).toBe('bottom');
  });
  it('아래까지 닿으면 오른쪽 도킹', () => {
    expect(dockAvoiding(rect(400, 100, 400, 750), viewport)).toBe('right');
  });
  it('어디 도킹해도 겹치면 float', () => {
    expect(dockAvoiding(rect(100, 50, 1200, 800), viewport)).toBe('float');
  });
});
