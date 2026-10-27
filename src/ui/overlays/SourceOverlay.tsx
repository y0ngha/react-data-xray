import { pathOf } from '../../core/requests/requestKey.js';
import type { Box } from '../../core/inspect/types.js';
import { getRenderInfo } from '../../core/render/monitor.js';
import { isWaste } from '../../core/requests/classify.js';
import { FixedRect } from '../components/FixedRect.js';
import { useRequestActions } from '../contexts.js';
import { useNow } from '../hooks/useNow.js';
import { useOverlayBoxes } from '../hooks/useOverlayBoxes.js';
import { useRenderMonitoring } from '../hooks/useRenderMonitoring.js';
import { color, MATCH_COLOR, SMALL_FONT, Z_OVERLAY } from '../theme.js';

// 렌더 직후 박스를 이만큼 보라색으로 강조한다(React DevTools 의 Highlight updates 처럼).
const FLASH_MS = 600;
// 깜빡임과 렌더 횟수만 갱신하는 짧은 주기(박스 위치는 따로 계산한다)
const FLASH_TICK_MS = 150;
// 최근 10초에 이만큼 넘게 렌더되면 렌더 폭주로 보고 숫자를 진하게 표시한다.
const RENDER_STORM = 10;

const SourceBox = ({ box, now }: { box: Box; now: number }) => {
  const { open, classOf } = useRequestActions();
  // 같은 엔드포인트의 다른 호출이 아니라, 이 데이터를 준 요청 자체가 낭비였을 때만 빨갛게 그린다.
  const boxColor = isWaste(classOf(box.hit.record)) ? color.warn : MATCH_COLOR[box.hit.match];
  const render = getRenderInfo(box.fiber, now);
  const flashing = !!render && now - render.last < FLASH_MS;
  return (
    <FixedRect
      rect={box.rect}
      style={{
        outline: flashing ? `2px solid ${color.render}` : `1px solid ${boxColor}`,
        background: flashing ? `${color.render}33` : `${boxColor}14`,
        zIndex: Z_OVERLAY,
      }}
    >
      <button
        type="button"
        title={`클릭하면 요청 상세를 봅니다${render ? ` · 최근 10초 렌더 ${render.recent}회, 줄일 수 있는 렌더 ${render.avoidable}회` : ''}`}
        onClick={() => open(box.hit.record)}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          pointerEvents: 'auto',
          cursor: 'pointer',
          border: 0,
          background: boxColor,
          color: '#000',
          font: SMALL_FONT,
          padding: '0 3px',
          whiteSpace: 'nowrap',
          maxWidth: '100%',
          overflow: 'hidden',
        }}
      >
        {render && render.recent > 0 && (
          <b style={{ color: render.recent >= RENDER_STORM ? '#7f1d1d' : '#000', marginRight: 4 }}>
            ↻{render.recent}
            {render.avoidable > 0 && `(불필요 ${render.avoidable})`}
          </b>
        )}
        {pathOf(box.hit.record.url)}
      </button>
    </FixedRect>
  );
};

/** ▦ 전체 표시: 데이터 출처가 있는 컴포넌트마다 박스, URL, 렌더 횟수를 그리고 렌더될 때마다 깜빡인다. */
export const SourceOverlay = () => {
  useRenderMonitoring();
  const boxes = useOverlayBoxes();
  const now = useNow(FLASH_TICK_MS);
  return (
    <>
      {boxes.map((box) => (
        <SourceBox key={`${box.name}|${box.rect.left}|${box.rect.top}|${box.hit.path}`} box={box} now={now} />
      ))}
    </>
  );
};
