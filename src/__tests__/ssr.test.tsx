// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RdxDevtools } from '../index.js';

describe('서버 렌더', () => {
  it('서버에서는 아무것도 그리지 않고 깨지지 않는다(Next.js 처럼 앱을 서버에서 먼저 그리는 경우)', () => {
    expect(renderToString(<RdxDevtools />)).toBe('');
  });
});
