import { useReducer } from 'react';

import { getResetAt } from '../../core/report/reportApi.js';
import { Button } from '../components/Button.js';
import { color } from '../theme.js';

const clock = (t: number) => new Date(t).toTimeString().slice(0, 8);

/** `window.__RDX__.reset()` 과 같은 동작(요청 기록·렌더 통계·캐시 감시 초기화. 무시 지정은 그대로)과 지운 시각 */
export const ResetButton = () => {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // 시각은 sessionStorage 에 있어 새로고침과 콘솔의 reset() 도 반영된다.
  const at = getResetAt();
  return (
    <>
      <Button
        onClick={() => {
          window.__RDX__?.reset();
          redraw();
        }}
        title="요청 기록, 렌더 통계, 배지 수를 지우고 지금부터 다시 잽니다. 무시로 지정한 엔드포인트는 유지됩니다."
      >
        기록 지우기
      </Button>
      {at !== null && <span style={{ color: color.muted }}>{clock(at)} 이후 기록</span>}
    </>
  );
};
