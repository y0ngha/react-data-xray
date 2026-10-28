import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RdxReport } from '../buildReport.js';
import { compare } from '../compare.js';
import { getResetAt, getSnapshot, getTabId, keepSnapshot, snapshotNames, watchTabIdConflict } from '../reportApi.js';

const rep = (components: Array<{ name: string; renders: number; avoidable?: number; renderedAt?: string }> = [], pad = '') =>
  ({
    requests: { endpoints: [{ endpoint: 'GET /x', count: 1, duplicates: 0, sameResponses: 0, pad }] },
    renders: { monitoring: true, windowSeconds: 10, components: components.map((c) => ({ avoidable: 0, ...c })) },
    reactQuery: { findings: [] },
  }) as unknown as RdxReport;

afterEach(() => vi.restoreAllMocks());

describe('compare: 같은 이름의 위치별 행 (PR5-1)', () => {
  it('이름이 같아도 renderedAt 이 다르면 따로 비교하고 위치를 싣는다', () => {
    const a = rep([
      { name: 'Row', renders: 2, renderedAt: 'A.tsx:1' },
      { name: 'Row', renders: 5, renderedAt: 'B.tsx:2' },
    ]);
    const b = rep([
      { name: 'Row', renders: 2, renderedAt: 'A.tsx:1' },
      { name: 'Row', renders: 9, renderedAt: 'B.tsx:2' },
    ]);
    expect(compare(a, b).renders).toEqual([{ name: 'Row', renderedAt: 'B.tsx:2', renders: 4 }]);
  });
});

describe('snapshot 보관 (PR5-2, PR5-3, ponytail PR5-5)', () => {
  it('숫자 이름은 객체 키 순서가 앞서도 오래된 것이 아니라 방금 저장한 것이 남는다', () => {
    ['a', 'b', 'c', 'd', 'e', 'f'].forEach((n) => keepSnapshot(n, rep()));
    keepSnapshot('1', rep());
    expect(snapshotNames()).toEqual(['b', 'c', 'd', 'e', 'f', '1']);
    expect(getSnapshot('1')).toBeTruthy();
  });

  it('비교에 쓰는 부분만 저장한다', () => {
    keepSnapshot('x', { ...rep(), howToRead: ['긴 설명'.repeat(100)] } as unknown as RdxReport);
    expect(Object.keys(getSnapshot('x')!)).toEqual(['requests', 'renders', 'reactQuery']);
    expect(sessionStorage.getItem('rdx:snapshots')).not.toContain('긴 설명');
  });

  it('용량이 넘치면 들어갈 때까지 오래된 것을 버리고 새 것을 남긴다', () => {
    keepSnapshot('old1', rep());
    keepSnapshot('old2', rep());
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === 'rdx:snapshots' && v.includes('old1')) throw new DOMException('full', 'QuotaExceededError');
      real.call(this, k, v);
    });
    keepSnapshot('new', rep());
    expect(snapshotNames()).toEqual(['old2', 'new']);
  });

  it('하나도 못 넣으면 경고한다', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    keepSnapshot('big', rep());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('big'));
  });
});

describe('탭 id 충돌 (ponytail PR5-3)', () => {
  it('같은 id 를 쓰는 탭이 먼저 열려 있으면 나중에 열린 탭이 새 id 를 받는다', () => {
    const channels: FakeChannel[] = [];
    class FakeChannel {
      handlers: Array<(e: { data: unknown }) => void> = [];
      constructor() {
        channels.push(this);
      }
      addEventListener(_type: string, handler: (e: { data: unknown }) => void) {
        this.handlers.push(handler);
      }
      postMessage(data: unknown) {
        channels.filter((c) => c !== this).forEach((c) => c.handlers.forEach((h) => h({ data })));
      }
    }
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    sessionStorage.setItem('rdx:tabId', JSON.stringify('dupdupdu'));
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1000);
    watchTabIdConflict(); // 먼저 열린 탭
    expect(getTabId()).toBe('dupdupdu');
    // 복제된 탭(같은 sessionStorage 값)은 나중에 연다.
    now.mockReturnValue(2000);
    watchTabIdConflict();
    expect(getTabId()).not.toBe('dupdupdu');
    vi.unstubAllGlobals();
  });
});

it('getResetAt: reset 한 시각을 sessionStorage 에서 읽는다 (PR5-10)', () => {
  expect(getResetAt()).toBeNull();
  sessionStorage.setItem('rdx:resetAt', '123');
  expect(getResetAt()).toBe(123);
});
