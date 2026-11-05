import { useEffect, useRef, useState } from 'react';

import { getMountStats } from '../../core/render/mounts.js';
import { findConsumers } from '../../core/inspect/consumers.js';
import type { Consumer } from '../../core/inspect/types.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { groupBy } from '../../shared/collections.js';
import { Button } from '../components/Button.js';
import { Muted } from '../components/Muted.js';
import { Section } from '../components/Section.js';
import { useRequestActions } from '../contexts.js';
import { useRecords } from '../hooks/useRecords.js';
import { isOwnUi } from '../ownUi.js';
import { codeBlockStyle } from '../theme.js';
import { VisibleFieldsSection } from './VisibleFields.js';

// 기록이 바뀐 뒤 이만큼 조용하면 쓰는 컴포넌트를 다시 찾는다(fiber 트리 전체를 훑으므로 폴링마다 바로 하지 않는다).
const REFIND_DELAY_MS = 1000;

/** 컴포넌트의 마운트·언마운트 횟수와 재마운트를 일으킨 부모. 기록이 없으면 아무것도 그리지 않는다. */
const MountNote = ({ name }: { name: string }) => {
  const { mounts, unmounts, remounts } = getMountStats(name);
  if (mounts === 0 && unmounts === 0) return null;
  return (
    <Muted>
      mount {mounts} · unmount {unmounts}
      {remounts
        .map((r) =>
          r.cause === 'type-changed'
            ? ` · component defined during render in <${r.parent || 'root'}>, remount ×${r.count}`
            : ` · <${r.parent || 'root'}> caused remount ×${r.count}`,
        )
        .join('')}
    </Muted>
  );
};

/** 이 요청의 데이터를 쓰는 컴포넌트를 이름별로 센다. 버튼으로 화면에서 강조를 켜고 끈다. 그 컴포넌트들의 화면 글자로 보이는 필드도 센다. */
export const ConsumerList = ({ record }: { record: RequestRecord }) => {
  const { hover } = useRequestActions();
  const [highlight, setHighlight] = useState(false);
  // 찾기 전에 큐를 비우므로 렌더가 끝난 다음 프레임에 찾는다. 큐의 step 이 다른 컴포넌트의 state 를 바꿀 수 있다.
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setConsumers(findConsumers(record, isOwnUi)));
    return () => cancelAnimationFrame(frame);
  }, [record]);
  // 상세를 연 채 새 응답이 오면(폴링·다시 받기) 쓰는 컴포넌트가 바뀔 수 있다. 몰려 와도 한 번만, 큐를 비우지 않고 다시 찾는다.
  const records = useRecords();
  const opened = useRef<{ record: RequestRecord; records: readonly RequestRecord[] } | null>(null);
  useEffect(() => {
    if (opened.current?.record !== record) {
      opened.current = { record, records };
      return undefined;
    }
    if (opened.current.records === records) return undefined;
    const timer = setTimeout(() => setConsumers(findConsumers(record, isOwnUi, 0)), REFIND_DELAY_MS);
    return () => clearTimeout(timer);
  }, [record, records]);
  const byName = Array.from(groupBy(consumers, (c) => c.name));
  // 상세를 떠나면 강조도 끈다.
  useEffect(() => () => hover(null), [hover]);
  const toggle = () => {
    hover(highlight ? null : record);
    setHighlight(!highlight);
  };
  return (
    <>
      <Section title={`Components using this response (${consumers.length})`}>
        <div style={codeBlockStyle}>
          {consumers.length === 0 ? (
            <>
              <Muted>No component found holding this response object (data may be transformed).</Muted>
              {record.component && (
                <div>
                  Sending component &lt;{record.component}&gt; <MountNote name={record.component} />
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
              <Button
                subtle
                active={highlight}
                onClick={toggle}
                title="Highlight these components on the page with an orange dashed border"
              >
                Highlight
              </Button>
            </>
          )}
        </div>
      </Section>
      <VisibleFieldsSection record={record} consumers={consumers} />
    </>
  );
};
