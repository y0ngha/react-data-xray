import { act, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import * as mountsModule from '../../../core/render/mounts.js';
import { createRecord, finishRecord } from '../../../core/requests/store.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { ConsumerList } from '../ConsumerList.js';
import { RequestDetail } from '../RequestDetail.js';
import { StackSection } from '../StackSection.js';

const mounts = { remounts: [] as Array<{ parent: string; count: number; lastAt: number; cause?: 'type-changed' }> };
vi.spyOn(mountsModule, 'getMountStats').mockImplementation(() => ({ mounts: 3, unmounts: 2, remounts: mounts.remounts }));

const done = (method: string, url: string): RequestRecord => {
  const r = createRecord('fetch', method, url);
  finishRecord(r, 200);
  return r;
};

describe('RequestDetail FollowUps (PR2-8)', () => {
  it('상세를 연 뒤 끝난 뒤따르는 조회도 반영한다', async () => {
    const save = done('POST', '/api/save');
    render(<RequestDetail record={save} onBack={() => undefined} />);
    expect(screen.queryByText(/Requests refetched after this one/)).toBeNull();
    await act(async () => {
      done('GET', '/api/after');
    });
    await waitFor(() => expect(screen.getByText(/Requests refetched after this one/)).toBeTruthy());
  });
});

describe('StackSection (ponytail PR2-7)', () => {
  it('앱 프레임이 없으면 접지 않고 전체를 보인다', () => {
    const html = renderToStaticMarkup(<StackSection stack={'at f (http://l/node_modules/ky/a.js:1:2)'} />);
    expect(html).toContain('ky/a.js');
    expect(html).not.toContain('expand');
  });
});

describe('ConsumerList MountNote (PR4-7)', () => {
  it('type-changed 재마운트는 렌더 중 정의한 컴포넌트로 안내한다', () => {
    mounts.remounts = [{ parent: 'List', count: 3, lastAt: 1, cause: 'type-changed' }];
    const record = { id: 1, kind: 'fetch', method: 'GET', url: '/a', startedAt: 0, durationMs: 1, component: 'Row' } as RequestRecord;
    const html = renderToStaticMarkup(<ConsumerList record={record} />);
    expect(html).toContain('component defined during render');
    expect(html).not.toContain('caused remount');
  });
});
