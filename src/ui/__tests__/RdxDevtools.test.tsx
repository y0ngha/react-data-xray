import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flush } from '../../testing/fetchMock.js';
import { RdxDevtools } from '../RdxDevtools.js';

const openPanel = () => {
  const button = screen.getByRole('button', { name: /React Data X-ray 열기/ });
  fireEvent.pointerDown(button, { clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerUp(button, { pointerId: 1 });
  return screen.getByRole('complementary', { name: 'React Data X-ray' });
};

afterEach(() => vi.restoreAllMocks());

describe('RdxDevtools', () => {
  it('버튼을 누르면 패널이 열리고, 탭을 영역별로 옮겨 다니며, 닫을 수 있다', async () => {
    render(<RdxDevtools />);
    const panel = openPanel();
    expect(within(panel).getByText(/요소 선택\]으로 화면의 요소를 고르면/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: '렌더' }));
    expect(within(panel).getByText(/렌더 분석 · 최근 10초/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: '네트워크 타임라인' }));
    expect(within(panel).getByText('네트워크 타임라인 · 최근 20초')).toBeTruthy();
    fireEvent.click(within(panel).getByTitle('닫기'));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('요청 기록에서 요청을 누르면 상세가 열리고, 뒤로 가면 탭으로 돌아온다', async () => {
    await fetch('/api/a');
    await fetch('/api/a');
    render(<RdxDevtools />);
    await act(flush);
    const panel = openPanel();
    // 중복 판정과 구독자 알림은 미뤄 두고 한 프레임에 한 번 묶어 반영한다.
    expect(await within(panel).findByRole('button', { name: /네트워크 요청 ⚠1/ })).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: /네트워크 요청/ }));
    fireEvent.click(within(panel).getByText('전체 기록'));
    fireEvent.click(within(panel).getAllByRole('button', { name: /GET \/api\/a/ })[0]);
    expect(within(panel).getByText('← 뒤로')).toBeTruthy();
    fireEvent.click(within(panel).getByText('← 뒤로'));
    expect(within(panel).getByText('엔드포인트별')).toBeTruthy();
  });

  it('단축키로 요소 선택을 켜고, 요소를 누르면 출처 결과를 보여 준다', async () => {
    const target = document.createElement('p');
    target.textContent = 'not from api';
    document.body.append(target);
    Object.defineProperty(document, 'elementFromPoint', { value: () => target, configurable: true });
    render(<RdxDevtools hotkey={{ key: 'e', shift: true }} />);
    fireEvent.keyDown(window, { key: 'e', metaKey: true, shiftKey: true });
    expect(screen.getByText(/분석할 요소를 화면에서 클릭하세요/)).toBeTruthy();
    fireEvent.click(target);
    expect(screen.getByText('연결된 API 응답을 찾지 못했습니다.')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    target.remove();
  });

  it('rdx 를 눌러도 앱의 "바깥 클릭"·포커스 처리가 깨지 않고, 앱 입력칸의 포커스도 빼앗지 않는다', () => {
    const appInput = document.createElement('input');
    document.body.append(appInput);
    appInput.focus();
    const outside = vi.fn<() => void>();
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    render(<RdxDevtools />);
    const panel = openPanel();
    const tab = within(panel).getByRole('button', { name: '렌더' });
    expect(fireEvent.mouseDown(tab)).toBe(false); // 기본 동작(포커스 이동)을 막았다
    fireEvent.pointerDown(tab);
    fireEvent.click(tab);
    expect(within(panel).getByText(/렌더 분석 · 최근 10초/)).toBeTruthy(); // rdx 자신의 처리는 그대로
    expect(outside).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(appInput);
    fireEvent.pointerDown(document.body);
    expect(outside).toHaveBeenCalledTimes(1);
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('focusin', outside);
    appInput.remove();
  });

  it('앱 모달이 열리면 도킹 패널을 접고, 펼칠 수 있으며, 모달이 닫히면 다시 원래대로 둔다', async () => {
    // jsdom 은 배치를 계산하지 않아, 보이는 요소로 치려면 사각형을 준다.
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList);
    // 변경 알림이 다음 프레임에 오므로 두 프레임을 기다린다.
    const frames = async (run: () => void) =>
      act(async () => {
        run();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
    render(<RdxDevtools />);
    const panel = openPanel();
    fireEvent.click(within(panel).getByTitle('하단에 도킹 (넓게 보기)'));
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    await frames(() => document.body.append(modal));
    const docked = screen.getByRole('complementary', { name: 'React Data X-ray' });
    expect(within(docked).getByText(/앱 대화상자가 열려 있어/)).toBeTruthy();
    fireEvent.click(within(docked).getByRole('button', { name: '펼치기' }));
    expect(within(docked).queryByText(/앱 대화상자가 열려 있어/)).toBeNull();
    await frames(() => modal.remove());
    // 다시 열리면 또 접는다(펼침은 그 모달이 닫힐 때까지만).
    await frames(() => document.body.append(modal));
    expect(within(docked).getByText(/앱 대화상자가 열려 있어/)).toBeTruthy();
    modal.remove();
  });

  it('도킹 방식을 바꾸면 기억하고, 하단 도킹에서는 끌어서 높이를 바꾼다', () => {
    render(<RdxDevtools />);
    const panel = openPanel();
    fireEvent.click(within(panel).getByTitle('하단에 도킹 (넓게 보기)'));
    expect(JSON.parse(localStorage.getItem('react-data-xray:dock')!).dock).toBe('bottom');
    const handle = within(screen.getByRole('complementary')).getByRole('separator');
    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientY: window.innerHeight - 400 });
    fireEvent.pointerUp(window);
    expect(JSON.parse(localStorage.getItem('react-data-xray:dock')!).bottomHeight).toBe(400);
    fireEvent.click(within(screen.getByRole('complementary')).getByTitle('오른쪽에 도킹'));
    expect(within(screen.getByRole('complementary')).getByRole('separator').getAttribute('aria-orientation')).toBe('vertical');
  });

  it('별도 창으로 띄우면 패널을 그 창에 그리고, 창이 막히면 작게 보기로 돌아온다', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<RdxDevtools />);
    const panel = openPanel();
    fireEvent.click(within(panel).getByTitle('도킹 해제 (별도 창)'));
    expect(JSON.parse(localStorage.getItem('react-data-xray:dock')!).dock).toBe('float');
  });

  it('화면 박스를 켜고 끌 수 있다', () => {
    render(<RdxDevtools />);
    const panel = openPanel();
    const toggle = within(panel).getByRole('button', { name: /박스/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('요소를 고르면 그 컴포넌트 안만 분석하고, 화면 전체로 돌아갈 수 있다', async () => {
    type Item = { id: number; title: string };
    const Row = ({ item }: { item: Item }) => <li>{item.title}</li>;
    const used: Item = await fetch('/api/used')
      .then((r) => r.json())
      .then((json) => json.data.list[0]);
    await fetch('/api/unused').then((r) => r.json());
    render(
      <ul>
        <Row item={used} />
      </ul>,
    );
    render(<RdxDevtools hotkey={{ key: 'e', shift: true }} />);
    await act(flush);
    const target = screen.getByText(used.title);
    Object.defineProperty(document, 'elementFromPoint', { value: () => target, configurable: true });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 10, 10));
    fireEvent.keyDown(window, { key: 'e', metaKey: true, shiftKey: true });
    fireEvent.click(target);
    const panel = screen.getByRole('complementary', { name: 'React Data X-ray' });
    expect(within(panel).getByRole('button', { name: '<Row> 안 ✕' })).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: /네트워크 요청/ }));
    expect(within(panel).getByText(/이 안의 컴포넌트가 쓰는 요청 1건/)).toBeTruthy();
    expect(within(panel).queryByText(/\/api\/unused/)).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: '<Row> 안 ✕' }));
    expect(within(panel).getByText(/GET \/api\/unused/)).toBeTruthy();
  });

  it('고른 컴포넌트가 화면에서 사라지면 화면 전체로 돌아간다', async () => {
    type Item = { id: number; title: string };
    const Row = ({ item }: { item: Item }) => <li>{item.title}</li>;
    const item: Item = await fetch('/api/gone')
      .then((r) => r.json())
      .then((json) => json.data.list[0]);
    const list = render(
      <ul>
        <Row item={item} />
      </ul>,
    );
    render(<RdxDevtools hotkey={{ key: 'e', shift: true }} />);
    const target = screen.getByText(item.title);
    Object.defineProperty(document, 'elementFromPoint', { value: () => target, configurable: true });
    fireEvent.keyDown(window, { key: 'e', metaKey: true, shiftKey: true });
    fireEvent.click(target);
    expect(screen.getByRole('button', { name: '<Row> 안 ✕' })).toBeTruthy();
    list.unmount();
    fireEvent.click(screen.getByRole('button', { name: /네트워크 요청/ }));
    expect(screen.queryByRole('button', { name: '<Row> 안 ✕' })).toBeNull();
  });
});
