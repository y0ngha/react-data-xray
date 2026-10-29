import { useId, useRef, useState, type FocusEvent, type MouseEvent, type PointerEvent, type Ref } from 'react';

import type { Position } from './hooks/useDraggable.js';
import type { Tab } from './panels/tabs.js';
import { color, Z_PANEL } from './theme.js';
import { clientViewport } from './viewport.js';

export const BUTTON_SIZE = 44;

export interface Breakdown {
  waste: readonly string[];
  storming: readonly string[];
}

const POPUP_WIDTH = 260;

const itemStyle = {
  display: 'block',
  width: '100%',
  padding: '2px 0',
  border: 0,
  background: 'none',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
} as const;

interface FloatingButtonProps {
  position: Position;
  /** 문제 수(낭비 요청이 있는 엔드포인트 + 렌더 폭주 컴포넌트). 0 보다 크면 테두리를 빨갛게 하고 숫자를 단다 */
  issues: number;
  /** 방금 요청이 몰렸거나 렌더 폭주가 생겼다. 애니메이션 없이 색만 잠깐 바꾼다(움직임을 줄이는 설정에도 부담 없게) */
  alert: boolean;
  /** 배지가 센 항목 이름. 주면 마우스를 올리거나 포커스할 때 내역을 보인다 */
  breakdown?: Breakdown;
  /** 내역의 항목을 눌렀을 때 그 탭으로 간다. key 는 엔드포인트나 컴포넌트 이름 */
  onSelect?: (tab: Tab, key: string) => void;
  handlers: {
    onPointerDown: (e: PointerEvent) => void;
    onPointerMove: (e: PointerEvent) => void;
    onPointerUp: () => void;
    onClick: (e: MouseEvent) => void;
  };
}

/** 끌어서 옮길 수 있는 RDX 버튼(표시만 한다. 드래그·클릭 처리는 useDraggable) */
const borderColor = (issues: number, alert: boolean): string => (alert ? color.render : issues > 0 ? color.warn : color.accent);

const Rdx = ({
  position,
  issues,
  alert,
  handlers,
  buttonRef,
  describedBy,
}: Omit<FloatingButtonProps, 'breakdown' | 'onSelect'> & { buttonRef?: Ref<HTMLButtonElement>; describedBy?: string }) => (
  <button
    ref={buttonRef}
    aria-describedby={describedBy}
    type="button"
    aria-label={`Open React Data X-ray${issues > 0 ? ` (${issues} issues)` : ''}`}
    title={`React Data X-ray (drag to move)${issues > 0 ? ` · ${issues} issues` : ''}`}
    {...handlers}
    style={{
      position: 'fixed',
      left: position.x,
      top: position.y,
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      borderRadius: '50%',
      border: `2px solid ${borderColor(issues, alert)}`,
      background: color.bg,
      color: color.text,
      font: 'bold 13px ui-monospace, Menlo, monospace',
      cursor: 'grab',
      zIndex: Z_PANEL,
      boxShadow: alert ? `0 0 0 4px ${color.render}66` : '0 2px 12px rgba(0,0,0,.4)',
      touchAction: 'none',
    }}
  >
    RDX
    {issues > 0 && (
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: -6,
          right: 0,
          minWidth: 18,
          height: 18,
          padding: '0 4px',
          borderRadius: 9,
          background: color.warn,
          color: '#000',
          font: 'bold 11px/18px ui-monospace, Menlo, monospace',
        }}
      >
        {issues > 99 ? '99+' : issues}
      </span>
    )}
  </button>
);

/** 내역 창. 버튼에 붙여 둬서 마우스가 버튼에서 창으로 옮겨 가도 닫히지 않는다. */
const BreakdownPopup = ({
  id,
  position,
  breakdown,
  onSelect,
}: {
  id: string;
  position: Position;
  breakdown: Breakdown;
  onSelect: (tab: Tab, key: string) => void;
}) => {
  const vp = clientViewport();
  const below = position.y < vp.height / 2;
  const section = (label: string, names: readonly string[], tab: Tab, show: (n: string) => string) =>
    names.length > 0 && (
      <div>
        <strong>
          {label} {names.length}
        </strong>
        {names.map((n) => (
          // mousedown 이 포커스를 가져가면(Safari) 클릭 전에 팝업이 닫힐 수 있어 막는다.
          <button
            key={n}
            type="button"
            title={show(n)}
            style={{ ...itemStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(tab, n)}
          >
            {show(n)}
          </button>
        ))}
      </div>
    );
  return (
    <div
      id={id}
      style={{
        position: 'fixed',
        left: Math.max(0, Math.min(position.x, vp.width - POPUP_WIDTH)),
        ...(below ? { top: position.y + BUTTON_SIZE } : { bottom: vp.height - position.y }),
        width: POPUP_WIDTH,
        padding: 8,
        border: `1px solid ${color.border}`,
        borderRadius: 6,
        background: color.bg,
        color: color.text,
        font: '12px ui-monospace, Menlo, monospace',
        zIndex: Z_PANEL,
      }}
    >
      {section('wasted requests', breakdown.waste, 'requests', (n) => n)}
      {section('render storm', breakdown.storming, 'renders', (n) => `<${n}>`)}
      <div style={{ marginTop: 4, color: color.muted }}>Render storm is based on the last 10s and will clear over time.</div>
    </div>
  );
};

export const FloatingButton = ({ breakdown, onSelect, ...rest }: FloatingButtonProps) => {
  const [open, setOpen] = useState(false);
  const popupId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const settling = useRef(false);
  if (!breakdown || !onSelect) return <Rdx {...rest} />;
  const close = () => setOpen(false);
  const shown = open && rest.issues > 0;
  return (
    <div
      role="presentation"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={close}
      onFocus={() => !settling.current && setOpen(true)}
      onBlur={(e: FocusEvent) => !e.currentTarget.contains(e.relatedTarget as Node | null) && close()}
      onKeyDown={(e) => e.key === 'Escape' && close()}
    >
      <Rdx {...rest} buttonRef={button} describedBy={shown ? popupId : undefined} />
      {shown && (
        <BreakdownPopup
          id={popupId}
          position={rest.position}
          breakdown={breakdown}
          onSelect={(tab, key) => {
            close();
            onSelect(tab, key);
            // 눌린 항목이 사라지면 포커스가 body 로 떨어지므로 RDX 버튼으로 옮긴다(다시 열리지 않게).
            settling.current = true;
            button.current?.focus();
            settling.current = false;
          }}
        />
      )}
    </div>
  );
};
