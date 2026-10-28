import { useEffect, useState } from 'react';

import { findConsumers } from '../../core/inspect/consumers.js';
import type { Consumer } from '../../core/inspect/types.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { FixedRect } from '../components/FixedRect.js';
import { isOwnUi } from '../ownUi.js';
import { color, SMALL_FONT, Z_HIGHLIGHT } from '../theme.js';

/** 호버한 요청의 응답 데이터를 쓰는 컴포넌트를 주황 점선으로 강조한다. */
// 행에 마우스를 올릴 때마다 찾으므로, 훑고 지나가도 멈추지 않게 큐는 짧게만 비운다.
const HOVER_FLUSH_MS = 100;

export const ConsumerHighlight = ({ record }: { record: RequestRecord }) => {
  // 찾기 전에 큐를 비우므로 렌더가 끝난 다음 프레임에 찾는다. 큐의 step 이 다른 컴포넌트의 state 를 바꿀 수 있다.
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setConsumers(findConsumers(record, isOwnUi, HOVER_FLUSH_MS)));
    return () => cancelAnimationFrame(frame);
  }, [record]);
  return (
    <>
      {consumers.map(
        (c) =>
          c.rect && (
            <FixedRect
              key={c.id}
              rect={c.rect}
              style={{ outline: `2px dashed ${color.consumer}`, background: `${color.consumer}1f`, zIndex: Z_HIGHLIGHT }}
            >
              <span
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  background: color.consumer,
                  color: '#000',
                  font: SMALL_FONT,
                  padding: '0 3px',
                }}
              >
                &lt;{c.name}&gt;
              </span>
            </FixedRect>
          ),
      )}
    </>
  );
};
