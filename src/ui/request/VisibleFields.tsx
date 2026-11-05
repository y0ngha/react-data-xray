import { useEffect, useMemo, useState } from 'react';

import type { Consumer } from '../../core/inspect/types.js';
import { measureVisibleFields, type VisibleFields } from '../../core/inspect/visibleFields.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { formatSize } from '../../shared/format.js';
import { Muted } from '../components/Muted.js';
import { Section } from '../components/Section.js';
import { isOwnUi } from '../ownUi.js';
import { codeBlockStyle } from '../theme.js';

// 소비자 DOM 이 바뀐 뒤 이만큼 조용하면 다시 센다(입력·애니메이션처럼 계속 바뀌는 화면에서 매번 세지 않는다).
const RECOUNT_DELAY_MS = 500;

const LOWER_BOUND_NOTE =
  'Lower bound: counts response fields whose value appears as visible text inside the components using this response. ' +
  'Fields used without being shown (ids, keys, conditions, sorting) are not counted, and a static label can coincide with a value.';

const notComparedText = ({ common, long, empty }: VisibleFields['notCompared']): string | null => {
  const parts = [
    common && `${common} common (0, true, single character)`,
    long && `${long} long text`,
    empty && `${empty} null/empty`,
  ].filter(Boolean);
  return parts.length ? `Not compared: ${parts.join(', ')}` : null;
};

const VisibleFieldsBody = ({ result, record, stale }: { result: VisibleFields; record: RequestRecord; stale: boolean }) => {
  const notCompared = notComparedText(result.notCompared);
  return (
    <>
      <div>
        Visible fields {result.visible} / {result.total}
        {record.responseBytes !== undefined && ` · ${record.responseBytesApprox ? '≈' : ''}${formatSize(record.responseBytes)}`}
        {stale && <Muted>(recounting…)</Muted>}
      </div>
      <Muted>{LOWER_BOUND_NOTE}</Muted>
      {notCompared && <Muted>{notCompared}</Muted>}
      {result.truncated && <Muted>Very large response: counted the first part only.</Muted>}
      {result.paths.length > 0 && <Muted>Shown: {result.paths.join(', ')}</Muted>}
    </>
  );
};

/** 소비자 DOM 이 바뀔 때마다(조용해진 뒤) 올라가는 번호 */
const useDomVersion = (nodes: readonly Element[]): number => {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (nodes.length === 0 || typeof MutationObserver === 'undefined') return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setVersion((v) => v + 1), RECOUNT_DELAY_MS);
    });
    nodes.forEach((n) => observer.observe(n, { subtree: true, childList: true, characterData: true, attributes: true }));
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [nodes]);
  return version;
};

/**
 * 과다 응답의 하한값: 응답의 leaf 필드 중 값이 소비자 컴포넌트의 보이는 글자에 나타난 수와 응답 크기.
 * 상세를 열었을 때, 그리고 연 채로 소비자나 그 DOM 이 바뀌면 다시 센다. 큰 응답도 유휴 큐에서 조각으로 센다(큐를 그 자리에서 비우지 않는다).
 */
export const VisibleFieldsSection = ({ record, consumers }: { record: RequestRecord; consumers: readonly Consumer[] }) => {
  const nodes = useMemo(() => consumers.flatMap((c) => c.nodes), [consumers]);
  const domVersion = useDomVersion(nodes);
  const [result, setResult] = useState<{
    record: RequestRecord;
    nodes: readonly Element[];
    domVersion: number;
    value: VisibleFields;
  } | null>(null);
  const { body } = record;
  useEffect(() => {
    if (body === undefined || nodes.length === 0) return undefined;
    return measureVisibleFields(body, nodes, isOwnUi, (value) => setResult({ record, nodes, domVersion, value }));
  }, [record, body, nodes, domVersion]);
  if (body === undefined || consumers.length === 0) return null;
  // 다른 요청을 열면 이전 결과는 보이지 않는다. 같은 요청을 다시 세는 동안에는 앞 결과를 두고 다시 센다고 밝힌다.
  const shown = result?.record === record ? result : null;
  return (
    <Section title="Fields visible on screen (lower bound)">
      <div style={codeBlockStyle}>
        {shown ? (
          <VisibleFieldsBody result={shown.value} record={record} stale={shown.nodes !== nodes || shown.domVersion !== domVersion} />
        ) : (
          <Muted>Counting…</Muted>
        )}
      </div>
    </Section>
  );
};
