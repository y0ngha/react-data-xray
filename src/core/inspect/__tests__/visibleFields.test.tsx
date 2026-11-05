import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithActions } from '../../../testing/withActions.js';
import { RequestDetail } from '../../../ui/request/RequestDetail.js';
import { MAX_NODES_PER_BODY } from '../../../shared/limits.js';
import { formatSize } from '../../../shared/format.js';
import { CHARS_PER_STEP, createByteCounter } from '../../requests/byteLength.js';
import { createRecord, finishRecord, keepResponseText, registerBody } from '../../requests/store.js';
import { flushQueue, isQueuePending } from '../../scheduler/idleQueue.js';
import { numberInText } from '../textMatch.js';
import { countVisibleFields, measureVisibleFields, NODES_PER_CALL, visibleFieldSteps } from '../visibleFields.js';

const BIO = 'b'.repeat(300);
const BODY = {
  name: 'Kim',
  total: 1234,
  count: 0,
  active: true,
  id: 'x9k',
  note: null,
  empty: '',
  secret: 'Secret1',
  styled: 'Hidden2',
  inline: 'Hidden3',
  blob: 'y'.repeat(3000),
  nested: { list: [{ title: 'Kim' }, { title: 'Lee' }] },
  bio: BIO,
};

const Card = ({ data, showId = false }: { data: typeof BODY; showId?: boolean }) => (
  <div>
    <b>{data.name}</b>
    <span>{data.total.toLocaleString('en-US')}</span>
    <span>{data.count}</span>
    <i>{data.nested.list[1].title}</i>
    <p>{data.bio}</p>
    <p>{data.blob}</p>
    {/* 보이지 않는 글자: hidden, style 요소, display:none */}
    <span hidden>{data.secret}</span>
    <style>{data.styled}</style>
    <em style={{ display: 'none' }}>{data.inline}</em>
    {showId && <small>{data.id}</small>}
  </div>
);

const noOwnUi = () => false;

describe('visibleFields: 화면에 보이는 필드 비율(과다 응답의 하한값) #88', () => {
  it('counts_leaf_values_in_visible_text: 필드 좁히기와 같은 규칙으로 보이는 글자의 leaf 만 세고, 비교하지 않은 값은 갈래별로 센다', () => {
    const { container } = render(<Card data={BODY} />);
    const result = countVisibleFields(BODY, [container.firstElementChild!], noOwnUi);
    // leaf 14개. 보임: name, total(1,234), title×2(list[0] 은 name 과 값이 같아 함께 센다), bio(300자도 통째로 그리면 같다).
    // 숨긴 secret·styled·inline 은 보이지 않는다. 0·true 는 흔한 값, 3000자 blob 은 긴 글자, null·'' 은 빈 값이라 비교하지 않는다.
    expect(result).toEqual({
      visible: 5,
      total: 14,
      notCompared: { common: 2, long: 1, empty: 2 },
      paths: ['$.name', '$.total', '$.nested.list[].title', '$.bio'],
      truncated: false,
    });
  });

  it('skips_own_ui_and_nested_roots: rdx 자신의 UI 는 읽지 않고, 겹친 소비자는 바깥 요소만 읽어도 같은 답이다', () => {
    const { container } = render(<Card data={BODY} />);
    const outer = container.firstElementChild!;
    expect(countVisibleFields(BODY, [outer, outer.querySelector('b')!, outer], noOwnUi)).toEqual(
      countVisibleFields(BODY, [outer], noOwnUi),
    );
    expect(countVisibleFields(BODY, [outer], (el) => el.tagName === 'B').visible).toBe(3); // Kim 이 화면에서 빠져 name 과 list[0].title 이 함께 빠진다
  });

  it('lazy_children: 10만 개 배열도 한 조각에서 NODES_PER_CALL 개까지만 읽는다', () => {
    let reads = 0;
    const list: unknown[] = [];
    for (let i = 0; i < 100_000; i++) Object.defineProperty(list, i, { enumerable: true, get: () => (reads++, i + 10) });
    const job = visibleFieldSteps({ list }, [], noOwnUi);
    let max = 0;
    let before = 0;
    let next = job.next();
    for (;;) {
      max = Math.max(max, reads - before);
      before = reads;
      if (next.done) break;
      next = job.next();
    }
    expect(next.value?.truncated).toBe(true); // 상한까지만 센다
    expect(max).toBeLessThanOrEqual(NODES_PER_CALL);
    expect(reads).toBeGreaterThanOrEqual(MAX_NODES_PER_BODY - 2);
  });

  it('restarts_text_on_rerender: 글자를 모으는 조각 사이에 소비자 DOM 이 바뀌면 처음부터 다시 모아 수가 줄지 않는다', () => {
    const root = document.createElement('div');
    document.body.append(root);
    root.innerHTML = '<span>a</span>'.repeat(NODES_PER_CALL * 2);
    const job = visibleFieldSteps({ name: 'Kim' }, [root], noOwnUi);
    expect(job.next().done).toBe(false);
    root.innerHTML = '<b>Kim</b>'; // 앱이 다시 그렸다
    let next = job.next();
    while (!next.done) next = job.next();
    expect(next.value.visible).toBe(1);
    root.remove();
  });

  it('chunks_in_idle_queue: 큰 응답은 유휴 큐에서 조각으로 세고, 그만 세면 결과를 알리지 않는다', () => {
    const list = Array.from({ length: 5000 }, (_, i) => ({ id: i, label: `item-${i}` }));
    const { container } = render(<p>item-42</p>);
    const done = vi.fn<(r: unknown) => void>();
    measureVisibleFields({ list }, [container], noOwnUi, done);
    flushQueue(0); // 한 조각만
    expect(done).not.toHaveBeenCalled();
    expect(isQueuePending()).toBe(true);
    flushQueue();
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ visible: 1, total: 10_000, paths: ['$.list[].label'] }));

    const ignored = vi.fn<(r: unknown) => void>();
    const cancel = measureVisibleFields({ list }, [container], noOwnUi, ignored);
    cancel();
    flushQueue();
    expect(ignored).not.toHaveBeenCalled();
  });

  it('numbers_and_sizes: 쉼표 숫자, UTF-8 바이트, 단위는 반올림한 뒤 고른다', () => {
    expect(numberInText('1,234')).toBe(1234);
    expect(numberInText(',')).toBeUndefined();
    expect(numberInText('abc')).toBeUndefined();
    const counter = createByteCounter('aé한😀\ud800');
    while (!counter.step());
    expect(counter.total()).toBe(1 + 2 + 3 + 4 + 3);
    const big = createByteCounter('a'.repeat(250_000));
    expect(big.step()).toBe(false); // 한 step 에 다 세지 않는다
    while (!big.step());
    expect(big.total()).toBe(250_000);
    const split = createByteCounter(`${'a'.repeat(CHARS_PER_STEP - 1)}😀`); // 쌍이 조각 경계에 걸린다
    while (!split.step());
    expect(split.total()).toBe(CHARS_PER_STEP - 1 + 4);
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(400 * 1024)).toBe('400 KB');
    expect(formatSize(1_048_575)).toBe('1 MB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3 MB');
  });

  it('request_detail_shows_ratio: 요청 상세에 보이는 필드 수 / 전체와 바이트, 하한값 설명이 나오고 화면이 바뀌면 다시 센다', async () => {
    const record = createRecord('fetch', 'GET', '/api/card');
    finishRecord(record, 200);
    const text = JSON.stringify(BODY);
    keepResponseText(record, text, { compare: false, reserialized: true });
    registerBody(record, JSON.parse(text));
    flushQueue();
    const body = record.body as typeof BODY;
    const App = () => {
      const [showId, setShowId] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setShowId(true)}>
            show id
          </button>
          <Card data={body} showId={showId} />
        </>
      );
    };
    render(<App />);
    renderWithActions(<RequestDetail record={record} onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByText(`Visible fields 5 / 14 · ≈${formatSize(text.length)}`)).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText('Fields visible on screen (lower bound)')).toBeTruthy();
    expect(screen.getByText(/^Lower bound:.*static label can coincide/)).toBeTruthy();
    expect(screen.getByText('Not compared: 2 common (0, true, single character), 1 long text, 2 null/empty')).toBeTruthy();
    expect(screen.getByText('Shown: $.name, $.total, $.nested.list[].title, $.bio')).toBeTruthy();
    fireEvent.click(screen.getByText('show id'));
    await waitFor(() => expect(screen.getByText(/^Visible fields 6 \/ 14/)).toBeTruthy(), { timeout: 3000 });
  });
});
