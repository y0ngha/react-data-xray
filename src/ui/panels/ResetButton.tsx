import { useReducer } from 'react';

import { getResetAt } from '../../core/report/reportApi.js';
import { formatTime } from '../../shared/format.js';
import { Button } from '../components/Button.js';
import { color } from '../theme.js';

/** `window.__RDX__.reset()` 과 같은 동작(요청 기록·렌더 통계·캐시 감시 초기화. 무시 지정은 그대로)과 지운 시각 */
export const ResetButton = ({ onReset }: { onReset?: () => void } = {}) => {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // 시각은 sessionStorage 에 있어 새로고침과 콘솔의 reset() 도 반영된다.
  const at = getResetAt();
  return (
    <>
      <Button
        onClick={() => {
          window.__RDX__?.reset();
          redraw();
          onReset?.();
        }}
        title="Clear request records, render stats, and badge counts. Ignored endpoints are kept."
      >
        Clear records
      </Button>
      {at !== null && <span style={{ color: color.muted }}>{formatTime(at)} since reset</span>}
    </>
  );
};
