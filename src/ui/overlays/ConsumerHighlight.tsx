import { useMemo } from 'react';

import { findConsumers } from '../../core/inspect/consumers.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { FixedRect } from '../components/FixedRect.js';
import { isOwnUi } from '../ownUi.js';
import { color, SMALL_FONT, Z_HIGHLIGHT } from '../theme.js';

/** 호버한 요청의 응답 데이터를 쓰는 컴포넌트를 주황 점선으로 강조한다. */
export const ConsumerHighlight = ({ record }: { record: RequestRecord }) => {
  const consumers = useMemo(() => findConsumers(record, isOwnUi), [record]);
  return (
    <>
      {consumers.map(
        (c) =>
          c.rect && (
            <FixedRect
              key={`${c.name}|${c.rect.left}|${c.rect.top}`}
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
