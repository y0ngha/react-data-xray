import { describe, expect, it } from 'vitest';

import { classifyRecords } from '../classify.js';
import { installSessionRecords, saveRecords } from '../sessionRecords.js';
import { clearRecords, createRecord, finishRecord, getRecords, keepResponseText, registerBody } from '../store.js';

const KEY = 'react-data-xray:records';

describe('탭 안에서 요청 기록 이어 가기', () => {
  it('새로고침 전 기록을 되살리되 응답 객체는 빼고 인증 헤더는 가리며, 새 요청은 그 뒤 번호를 받는다', () => {
    const record = createRecord('fetch', 'GET', '/api/users');
    record.requestHeaders = { authorization: 'Bearer secret', accept: 'application/json' };
    finishRecord(record, 200);
    keepResponseText(record, '{"users":[1]}', { compare: true });
    registerBody(record, { users: [1] });
    saveRecords();

    // 새로고침: 메모리는 비고 sessionStorage 만 남는다.
    clearRecords();
    installSessionRecords();
    const [restored] = getRecords();
    expect(restored).toMatchObject({ url: '/api/users', restored: true, responseText: '{"users":[1]}' });
    expect(restored.body).toBeUndefined();
    expect(restored.requestHeaders).toEqual({ authorization: '(가림)', accept: 'application/json' });
    const next = createRecord('fetch', 'GET', '/api/users');
    expect(next.id).toBeGreaterThan(restored.id);
    // 새로고침 직후 다시 나간 같은 요청을 중복으로 찍지 않는다.
    expect(next.duplicateOf).toBeUndefined();
  });

  it('비밀번호·토큰은 본문·원문·쿼리 어디에 있어도 가려서 저장하고, 되살린 뒤에는 저장소를 비운다', () => {
    const login = createRecord('fetch', 'POST', '/api/login?token=abc&page=1', '{"id":"kim","password":"pw"}');
    finishRecord(login, 200);
    keepResponseText(login, '{"accessToken":"t0k3n"}', { compare: false });
    saveRecords();
    const raw = sessionStorage.getItem(KEY) ?? '';
    expect(raw).not.toMatch(/pw"|t0k3n|token=abc/);
    clearRecords();
    installSessionRecords();
    expect(getRecords()[0]).toMatchObject({ url: '/api/login?token=(가림)&page=1', requestBody: '(가림)', responseText: '(가림)' });
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('주기 판정은 같은 페이지 로드 안에서만 한다(새로고침 사이 간격으로 주기가 깨지지 않는다)', () => {
    const at = (t: number) => {
      const r = createRecord('fetch', 'GET', '/api/poll');
      r.startedAt = t;
      finishRecord(r, 200);
      keepResponseText(r, '{"same":1}', { compare: true });
      return r;
    };
    installSessionRecords();
    [0, 5000, 10_000, 15_000].forEach(at);
    saveRecords();
    clearRecords();
    installSessionRecords();
    // 새로고침 1초 뒤부터 다시 5초 주기
    [16_000, 21_000, 26_000, 31_000].forEach(at);
    const classes = classifyRecords(getRecords(), new Set());
    expect(
      new Set(
        getRecords()
          .map((r) => classes.get(r.id))
          .filter((c) => c !== 'ok'),
      ),
    ).toEqual(new Set(['periodic']));
  });

  it('bfcache 로 돌아온 페이지는 그사이 다른 페이지가 저장한 기록을 합친다', () => {
    installSessionRecords();
    const mine = createRecord('fetch', 'GET', '/api/a');
    finishRecord(mine, 200);
    // 다른 페이지가 이 기록과 자기 기록을 저장해 둔 상황
    const other = { ...mine, id: mine.id + 1, url: '/api/b' };
    sessionStorage.setItem(
      KEY,
      JSON.stringify([
        { ...mine, restored: true },
        { ...other, restored: true },
      ]),
    );
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(getRecords().map((r) => r.url)).toEqual(['/api/a', '/api/b']);
    expect(createRecord('fetch', 'GET', '/api/c').id).toBeGreaterThan(other.id);
  });

  it('저장소 용량을 넘기지 않게 오래된 기록부터 버린다', () => {
    const big = 'x'.repeat(20_000);
    Array.from({ length: 80 }, (_, i) => {
      const r = createRecord('fetch', 'GET', `/api/big/${i}`);
      finishRecord(r, 200);
      keepResponseText(r, big, { compare: false });
      return r;
    });
    saveRecords();
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as Array<{ url: string }>;
    expect(sessionStorage.getItem(KEY)!.length).toBeLessThanOrEqual(500_000);
    expect(saved.length).toBeLessThan(80);
    expect(saved.at(-1)?.url).toBe('/api/big/79');
  });
});
