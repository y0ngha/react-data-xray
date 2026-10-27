import { type ReactNode, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { ownUiProps } from '../ownUi.js';

/**
 * 이 레이어에서 멈추는 이벤트. 앱은 문서에서 이것들을 보고 "바깥을 눌렀다"·"포커스가 밖으로 나갔다"고 읽는다
 * (드롭다운·팝오버 닫기, 모달 포커스 트랩). rdx 를 누른 것은 앱 바깥이 아니라 도구를 쓴 것이다.
 */
const CONTAINED_EVENTS = ['pointerdown', 'mousedown', 'touchstart', 'click', 'focusin'] as const;

// 누를 때 포커스를 가져가지 않을 요소. 앱 입력칸의 포커스가 빠지면 그 입력칸의 드롭다운이 닫힌다. 글을 쓰는 칸은 포커스가 필요해 뺀다.
const KEEPS_APP_FOCUS = 'button, a, summary, [role="button"], [role="tab"]';

const contain = (event: Event): void => {
  if (event.type === 'mousedown' && event.target instanceof Element && event.target.closest(KEEPS_APP_FOCUS)) event.preventDefault();
  event.stopPropagation();
};

/** host 안에서 일어난 이벤트가 문서까지 올라가지 않게 한다. React 는 이 컨테이너에서 먼저 처리한 뒤다(포털 컨테이너에 먼저 붙는다). */
export const containOwnEvents = (host: HTMLElement): (() => void) => {
  CONTAINED_EVENTS.forEach((type) => host.addEventListener(type, contain));
  return () => CONTAINED_EVENTS.forEach((type) => host.removeEventListener(type, contain));
};

/**
 * rdx 화면(패널·버튼·오버레이)을 그릴 전용 컨테이너. document.body 에 바로 포털하면 rdx 를 누른 이벤트가 문서까지 올라가
 * 앱의 열린 드롭다운이 닫힌다. 서버 렌더에서는 null 이다(포털은 그 자리에 마크업을 남기지 않아 hydration 이 어긋나지 않는다).
 */
export const useOwnLayer = (): HTMLElement | null => {
  const [host] = useState(() => {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    Object.entries(ownUiProps).forEach(([name, value]) => el.setAttribute(name, value));
    return el;
  });
  useLayoutEffect(() => {
    if (!host) return;
    document.body.appendChild(host);
    const release = containOwnEvents(host);
    return () => {
      release();
      host.remove();
    };
  }, [host]);
  return host;
};

/** rdx 화면을 전용 컨테이너에 그리는 함수. 컨테이너가 없으면(서버 렌더) 아무것도 그리지 않는다. */
export const useOwnLayerPortal = (): ((children: ReactNode) => ReactNode) => {
  const host = useOwnLayer();
  return (children) => (host ? createPortal(children, host) : null);
};
