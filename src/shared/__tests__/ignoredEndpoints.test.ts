import { describe, expect, it } from 'vitest';

import { parseIgnored } from '../ignoredEndpoints.js';

describe('parseIgnored (PR2-3)', () => {
  it('ID 묶기 전에 저장한 경로는 지금 형식으로 바꿔 읽는다', () => {
    expect([...(parseIgnored(['GET /items/5', 'GET /items/:id', 'GET /me', 3]) ?? [])]).toEqual(['GET /items/:id', 'GET /me']);
  });
});
