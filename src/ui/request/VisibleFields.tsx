import { useEffect, useState } from 'react';

import type { Consumer } from '../../core/inspect/types.js';
import { measureVisibleFields, type VisibleFields } from '../../core/inspect/visibleFields.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { formatSize } from '../../shared/format.js';
import { Muted } from '../components/Muted.js';
import { Section } from '../components/Section.js';
import { codeBlockStyle } from '../theme.js';

const LOWER_BOUND_NOTE =
  'Lower bound: counts response fields whose value appears as text inside the components using this response. ' +
  'Fields used without being shown (ids, keys, conditions, sorting) are not counted.';

const VisibleFieldsBody = ({ result, size }: { result: VisibleFields; size?: number }) => (
  <>
    <div>
      Visible fields {result.visible} / {result.total}
      {size !== undefined && ` · ${formatSize(size)}`}
    </div>
    <Muted>{LOWER_BOUND_NOTE}</Muted>
    {result.common > 0 && <Muted>Not matched (common values like 0, true or short text): {result.common}</Muted>}
    {result.truncated && <Muted>Very large response: counted the first part only.</Muted>}
    {result.paths.length > 0 && <Muted>Shown: {result.paths.join(', ')}</Muted>}
  </>
);

/**
 * 과다 응답의 하한값: 응답의 leaf 필드 중 값이 소비자 컴포넌트의 화면 글자에 나타난 수와 응답 크기.
 * 사용자가 상세를 열었을 때만 세고, 큰 응답도 유휴 큐에서 조각으로 센다(큐를 그 자리에서 비우지 않는다).
 */
export const VisibleFieldsSection = ({ record, consumers }: { record: RequestRecord; consumers: readonly Consumer[] }) => {
  const [result, setResult] = useState<{ consumers: readonly Consumer[]; value: VisibleFields } | null>(null);
  const { body } = record;
  useEffect(() => {
    if (body === undefined || consumers.length === 0) return undefined;
    return measureVisibleFields(
      body,
      consumers.flatMap((c) => c.nodes),
      (value) => setResult({ consumers, value }),
    );
  }, [body, consumers]);
  if (body === undefined || consumers.length === 0) return null;
  // 소비자가 바뀌면(다른 요청을 열면) 이전 결과는 보이지 않는다.
  const current = result?.consumers === consumers ? result.value : null;
  return (
    <Section title="Fields shown on screen">
      <div style={codeBlockStyle}>
        {current ? <VisibleFieldsBody result={current} size={record.responseSize} /> : <Muted>Counting…</Muted>}
      </div>
    </Section>
  );
};
