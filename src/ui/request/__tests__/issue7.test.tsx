// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';

import { recordMounts, resetMounts } from '../../../core/render/mounts.js';
import type { Fiber } from '../../../core/fiber/types.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { ConsumerList } from '../ConsumerList.js';

function Child() {}
function List() {}
const f = (type: unknown) => ({ tag: 0, type, return: null }) as unknown as Fiber;

describe('요청 상세의 마운트 기록', () => {
  beforeEach(resetMounts);
  it('응답을 쓰는 컴포넌트가 없으면 보낸 컴포넌트를 따로 표기하고 마운트 횟수와 재마운트 부모를 보인다', () => {
    const list = f(List);
    const a = f(Child);
    recordMounts([], [{ fiber: a, parent: list, branch: list }], 0);
    recordMounts([{ fiber: a, parent: list }], [{ fiber: f(Child), parent: list, branch: list }], 10);
    const record = { id: 1, component: 'Child' } as RequestRecord;
    const html = renderToStaticMarkup(<ConsumerList record={record} />);
    expect(html).toContain('Sending component');
    expect(html).toContain('mount 2 · unmount 1');
    expect(html).toContain('&lt;List&gt; caused remount ×1');
  });
});
