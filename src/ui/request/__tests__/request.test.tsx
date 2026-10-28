import { vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { flushQueue } from '../../../core/scheduler/idleQueue.js';
import { createRecord, finishRecord, keepResponseText, registerBody } from '../../../core/requests/store.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { renderWithActions } from '../../../testing/withActions.js';
import { ClassBadge } from '../ClassBadge.js';
import { RequestDetail } from '../RequestDetail.js';
import { RequestLink } from '../RequestLink.js';
import { RequestParams } from '../RequestParams.js';

const makeRecord = (extra: Partial<RequestRecord> = {}): RequestRecord => {
  const record = createRecord('fetch', 'POST', '/api/item?id=7&id=8', '{"id":7}');
  finishRecord(record, 200);
  return Object.assign(record, extra);
};

describe('RequestLink', () => {
  it('누르면 상세를 열고(키보드는 button 이 처리), 호버·포커스로 강조를 켜고 끈다', () => {
    const record = makeRecord();
    const { actions } = renderWithActions(
      <RequestLink record={record} focus={{ path: '$', via: 'props' }}>
        link
      </RequestLink>,
    );
    const link = screen.getByRole('button');
    expect(link.tagName).toBe('BUTTON');
    fireEvent.click(link);
    expect(actions.open).toHaveBeenCalledTimes(1);
    expect(actions.open).toHaveBeenCalledWith(record, { path: '$', via: 'props' });
    fireEvent.mouseEnter(link);
    fireEvent.mouseLeave(link);
    fireEvent.focus(link);
    fireEvent.blur(link);
    expect(actions.hover).toHaveBeenNthCalledWith(1, record);
    expect(actions.hover).toHaveBeenNthCalledWith(2, null);
    expect(actions.hover).toHaveBeenCalledTimes(4);
  });
});

describe('ClassBadge, RequestParams', () => {
  it('분류가 있을 때만 배지를 그리고 짧은 이름도 쓸 수 있다', () => {
    const record = makeRecord();
    const { container, rerender } = renderWithActions(<ClassBadge record={record} />);
    expect(container.textContent).toBe('');
    renderWithActions(<ClassBadge record={record} short />, () => 'same-response');
    expect(screen.getByText('같은 응답')).toBeTruthy();
    rerender(<span />);
  });

  it('쿼리와 payload, 읽을 수 없는 본문을 보여 준다', () => {
    renderWithActions(<RequestParams record={makeRecord({ bodyUnreadable: true })} />);
    expect(screen.getByText(/query: \?id=7&id=8/)).toBeTruthy();
    expect(screen.getByText(/payload: \{"id":7\}/)).toBeTruthy();
    expect(screen.getByText(/읽을 수 없는 본문/)).toBeTruthy();
  });
});

describe('RequestDetail', () => {
  it('컴포넌트가 쓰는 데이터, 보낸 코드, 쿼리, 헤더, 본문을 보여 준다', () => {
    const record = makeRecord({
      requestHeaders: { 'x-token': 't' },
      responseHeaders: { 'x-trace': 'a' },
      stack: 'at App (App.tsx:1)',
      trigger: 'focus',
    });
    registerBody(record, { data: { id: 7, name: 'cpu' } });
    const onBack = vi.fn<() => void>();
    renderWithActions(<RequestDetail record={record} focus={{ path: '$.data', via: 'props.item' }} onBack={onBack} />, () => 'duplicate');
    expect(screen.getByText(/이 컴포넌트가 쓰는 데이터: \$\.data ← props\.item/)).toBeTruthy();
    expect(screen.getByText('중복 요청')).toBeTruthy();
    expect(screen.getByText(/창 포커스/)).toBeTruthy();
    expect(screen.getByText('at App (App.tsx:1)')).toBeTruthy();
    expect(screen.getByText('7, 8')).toBeTruthy();
    expect(screen.getByText('x-token:')).toBeTruthy();
    expect(screen.getAllByText(/"name": "cpu"/).length).toBeGreaterThan(0);
    expect(screen.getByText(/이 요청의 데이터를 쓰는 컴포넌트 \(0\)/)).toBeTruthy();
    fireEvent.click(screen.getByText('← 뒤로'));
    expect(onBack).toHaveBeenCalled();
  });

  it('본문이 없거나 읽을 수 없거나 텍스트 원문만 있는 경우를 나눠 보여 준다', () => {
    const textOnly = makeRecord({ requestBody: undefined });
    keepResponseText(textOnly, '{"raw":true}', { compare: false });
    flushQueue(); // 원문 보관은 미뤄 둔다
    const { unmount } = renderWithActions(<RequestDetail record={textOnly} onBack={() => undefined} />);
    expect(screen.getByText(/"raw": true/)).toBeTruthy();
    expect(screen.getAllByText('(없음)').length).toBeGreaterThan(0);
    unmount();
    renderWithActions(
      <RequestDetail record={makeRecord({ bodyUnreadable: true, error: 'TypeError: x', status: 0 })} onBack={() => undefined} />,
    );
    expect(screen.getByText(/바로 읽을 수 없는 본문/)).toBeTruthy();
    expect(screen.getByText(/아직 받지 못했습니다/)).toBeTruthy();
    expect(screen.getByText(/실패 \(TypeError: x\)/)).toBeTruthy();
  });

  it('복사 버튼은 펼침을 바꾸지 않고 클립보드에 쓴다', () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithActions(<RequestDetail record={makeRecord()} onBack={() => undefined} />);
    fireEvent.click(screen.getAllByText('복사')[0]);
    expect(writeText).toHaveBeenCalledWith('{\n  "id": 7\n}');
  });
});

describe('잘못 인코딩된 쿼리', () => {
  it('퍼센트 인코딩이 깨진 쿼리도 원문 그대로 보여 주고 렌더를 깨지 않는다', () => {
    const record = createRecord('fetch', 'GET', '/api/search?q=100%');
    finishRecord(record, 200);
    renderWithActions(<RequestParams record={record} />);
    expect(screen.getByText(/q=100%/)).toBeTruthy();
  });
});
