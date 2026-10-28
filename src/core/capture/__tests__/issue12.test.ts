import { describe, expect, it } from 'vitest';

import { flush } from '../../../testing/fetchMock.js';
import { buildReport } from '../../report/buildReport.js';
import { getRecords } from '../../requests/store.js';
import { componentOfStack } from '../callerComponent.js';

describe('요청의 경로와 컴포넌트 (#12)', () => {
  it('spa_navigation: pushState 뒤 요청은 새 경로로 기록되고 앞 요청은 그대로다', async () => {
    history.pushState({}, '', '/projects?tab=1');
    await fetch('/api/nav-a');
    history.pushState({}, '', '/dashboard');
    await fetch('/api/nav-b');
    await flush();
    const byUrl = (u: string) => getRecords().find((r) => r.url === u);
    expect(byUrl('/api/nav-a')?.route).toBe('/projects');
    expect(byUrl('/api/nav-b')?.route).toBe('/dashboard');
  });

  it('보고서 callers 에 경로와 컴포넌트가 들어간다', async () => {
    history.pushState({}, '', '/report-route');
    await fetch('/api/in-report');
    await flush();
    const e = buildReport(false).requests.endpoints.find((x) => x.endpoint === 'GET /api/in-report');
    expect(e?.callers[0]).toMatchObject({ route: '/report-route', count: 1 });
  });

  describe('componentOfStack', () => {
    it('API 래퍼와 라이브러리 프레임을 건너뛰고 첫 대문자 이름 함수를 쓴다', () => {
      const stack = [
        'at getSummaryA (http://l/src/api.ts:3:4)',
        'at wrap (http://l/node_modules/ky/index.js:1:2)',
        'at SummaryCard (http://l/src/SummaryCard.tsx:10:5)',
        'at renderWithHooks (http://l/node_modules/react-dom/x.js:1:1)',
      ].join('\n');
      expect(componentOfStack(stack)).toBe('SummaryCard');
    });
    it('클래스 메서드는 클래스 이름, Firefox 형식도 읽는다', () => {
      expect(componentOfStack('at async ItemCard.loadData (http://l/src/a.ts:1:2)')).toBe('ItemCard');
      expect(componentOfStack('fetchIt@http://l/a.ts:1:2\nItemList@http://l/b.tsx:3:4')).toBe('ItemList');
    });
    it('DOM 수신자 이름은 컴포넌트가 아니고, Firefox 의 A/load@ 줄은 A 다', () => {
      expect(componentOfStack('at HTMLButtonElement.onClick (http://l/a.ts:1:2)\nat Document.x (http://l/a.ts:1:2)\nat WebSocket.send (http://l/a.ts:1:2)')).toBeUndefined();
      expect(componentOfStack('ItemCard/load@http://l/a.ts:1:2')).toBe('ItemCard');
    });
    it('판정할 수 없으면 비운다', () => {
      expect(componentOfStack('at load (http://l/src/api.ts:3:4)\nat Object.run (http://l/x.ts:1:2)')).toBeUndefined();
      expect(componentOfStack(undefined)).toBeUndefined();
    });
  });
});
