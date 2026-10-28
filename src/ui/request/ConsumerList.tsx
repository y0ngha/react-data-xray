import { useEffect, useState } from 'react';

import { getMountStats } from '../../core/render/mounts.js';
import { findConsumers } from '../../core/inspect/consumers.js';
import type { Consumer } from '../../core/inspect/types.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { groupBy } from '../../shared/collections.js';
import { Button } from '../components/Button.js';
import { Muted } from '../components/Muted.js';
import { Section } from '../components/Section.js';
import { useRequestActions } from '../contexts.js';
import { isOwnUi } from '../ownUi.js';
import { codeBlockStyle } from '../theme.js';

/** 컴포넌트의 마운트·언마운트 횟수와 재마운트를 일으킨 부모. 기록이 없으면 아무것도 그리지 않는다. */
const MountNote = ({ name }: { name: string }) => {
  const { mounts, unmounts, remounts } = getMountStats(name);
  if (mounts === 0 && unmounts === 0) return null;
  return (
    <Muted>
      마운트 {mounts} · 언마운트 {unmounts}
      {remounts
        .map((r) =>
          r.cause === 'type-changed'
            ? ` · 부모 <${r.parent || '루트'}> 가 렌더 중에 정의한 컴포넌트라 재마운트 ×${r.count}`
            : ` · 부모 <${r.parent || '루트'}> 때문에 재마운트 ×${r.count}`,
        )
        .join('')}
    </Muted>
  );
};

/** 이 요청의 데이터를 쓰는 컴포넌트를 이름별로 센다. 버튼으로 화면에서 강조를 켜고 끈다. */
export const ConsumerList = ({ record }: { record: RequestRecord }) => {
  const { hover } = useRequestActions();
  const [highlight, setHighlight] = useState(false);
  // 찾기 전에 큐를 비우므로 렌더가 끝난 다음 프레임에 찾는다. 큐의 step 이 다른 컴포넌트의 state 를 바꿀 수 있다.
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setConsumers(findConsumers(record, isOwnUi)));
    return () => cancelAnimationFrame(frame);
  }, [record]);
  const byName = Array.from(groupBy(consumers, (c) => c.name));
  // 상세를 떠나면 강조도 끈다.
  useEffect(() => () => hover(null), [hover]);
  const toggle = () => {
    hover(highlight ? null : record);
    setHighlight(!highlight);
  };
  return (
    <Section title={`이 요청의 데이터를 쓰는 컴포넌트 (${consumers.length})`}>
      <div style={codeBlockStyle}>
        {consumers.length === 0 ? (
          <>
            <Muted>지금 화면에서 이 응답 객체를 들고 있는 컴포넌트를 찾지 못했습니다(가공된 데이터일 수 있습니다).</Muted>
            {record.component && (
              <div>
                요청을 보낸 컴포넌트 &lt;{record.component}&gt; <MountNote name={record.component} />
              </div>
            )}
          </>
        ) : (
          <>
            {byName.map(([name, list]) => (
              <div key={name}>
                &lt;{name}&gt; {list.length > 1 && `× ${list.length}`} <Muted>← {list[0].via}</Muted> <MountNote name={name} />
              </div>
            ))}
            <Button subtle active={highlight} onClick={toggle} title="이 컴포넌트들을 화면에서 주황 점선으로 강조합니다">
              화면에서 강조
            </Button>
          </>
        )}
      </div>
    </Section>
  );
};
