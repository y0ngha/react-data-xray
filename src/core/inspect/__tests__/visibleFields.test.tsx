import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithActions } from '../../../testing/withActions.js';
import { RequestDetail } from '../../../ui/request/RequestDetail.js';
import { MAX_NODES_PER_BODY } from '../../../shared/limits.js';
import { formatSize } from '../../../shared/format.js';
import { createRecord, finishRecord, keepResponseText, registerBody } from '../../requests/store.js';
import { flushQueue, isQueuePending } from '../../scheduler/idleQueue.js';
import { numberInText } from '../textMatch.js';
import { countVisibleFields, measureVisibleFields } from '../visibleFields.js';

const BODY = {
  name: 'Kim',
  total: 1234,
  count: 0,
  active: true,
  id: 'x9k',
  nested: { list: [{ title: 'Kim' }, { title: 'Lee' }] },
};

const Card = ({ data }: { data: typeof BODY }) => (
  <div>
    <b>{data.name}</b>
    <span>{data.total.toLocaleString('en-US')}</span>
    <span>{data.count}</span>
    <i>{data.nested.list[1].title}</i>
  </div>
);

describe('visibleFields: 화면에 보이는 필드 비율(과다 응답의 하한값) #88', () => {
  it('counts_leaf_values_in_screen_text: 필드 좁히기와 같은 규칙(천 단위 쉼표)으로 보인 leaf 를 세고 흔한 값은 비교하지 않는다', () => {
    const { container } = render(<Card data={BODY} />);
    const result = countVisibleFields(BODY, [container.firstElementChild!]);
    // leaf: name, total, count, active, id, title×2 = 7. 0 과 true 는 화면에 있어도 우연히 겹치므로 세지 않는다.
    // list[0].title 은 name 과 값이 같아 함께 보인 것으로 센다(값 비교라 어느 필드가 그렸는지는 모른다).
    expect(result).toEqual({
      visible: 4,
      total: 7,
      common: 2,
      paths: ['$.name', '$.total', '$.nested.list[].title'],
      truncated: false,
    });
  });

  it('reads_nested_consumers_once: 목록과 그 행처럼 겹친 소비자는 바깥 요소만 읽어도 같은 답이다', () => {
    const { container } = render(<Card data={BODY} />);
    const outer = container.firstElementChild!;
    expect(countVisibleFields(BODY, [outer, outer.querySelector('b')!, outer])).toEqual(countVisibleFields(BODY, [outer]));
  });

  it('chunks_large_response: 큰 응답은 유휴 큐에서 조각으로 세고, 그만 세면 결과를 알리지 않는다', () => {
    const list = Array.from({ length: 5000 }, (_, i) => ({ id: i, label: `item-${i}` }));
    const { container } = render(<p>item-42</p>);
    const done = vi.fn<(r: unknown) => void>();
    measureVisibleFields({ list }, [container], done);
    flushQueue(0); // 한 조각만
    expect(done).not.toHaveBeenCalled();
    expect(isQueuePending()).toBe(true);
    flushQueue();
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ visible: 1, total: 10_000, paths: ['$.list[].label'] }));

    const ignored = vi.fn<(r: unknown) => void>();
    const cancel = measureVisibleFields({ list }, [container], ignored);
    cancel();
    flushQueue();
    expect(ignored).not.toHaveBeenCalled();
  });

  it('caps_huge_response: 아주 큰 응답은 상한까지만 세고 그렇다고 밝힌다', () => {
    const huge = Array.from({ length: MAX_NODES_PER_BODY }, (_, i) => i);
    expect(countVisibleFields(huge, [])).toMatchObject({ truncated: true, visible: 0 });
  });

  it('numberInText: 쉼표를 걷어 숫자로 읽고, 쉼표뿐인 글자는 숫자가 아니다', () => {
    expect(numberInText('1,234')).toBe(1234);
    expect(numberInText(',')).toBeUndefined();
    expect(numberInText('abc')).toBeUndefined();
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(400 * 1024)).toBe('400 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3 MB');
  });

  it('request_detail_shows_ratio: 요청 상세에 보이는 필드 수 / 전체와 응답 크기, 하한값이라는 설명이 나온다', async () => {
    const record = createRecord('fetch', 'GET', '/api/card');
    finishRecord(record, 200);
    const text = JSON.stringify(BODY);
    keepResponseText(record, text, { compare: false });
    registerBody(record, JSON.parse(text));
    flushQueue();
    const body = record.body as typeof BODY;
    render(<Card data={body} />);
    renderWithActions(<RequestDetail record={record} onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByText(`Visible fields 4 / 7 · ${formatSize(text.length)}`)).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByText(/^Lower bound:/)).toBeTruthy();
    expect(screen.getByText(/common values like 0, true or short text\): 2/)).toBeTruthy();
    expect(screen.getByText('Shown: $.name, $.total, $.nested.list[].title')).toBeTruthy();
  });
});
