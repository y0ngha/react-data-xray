import { useMemo } from 'react';

import { queryContextOf } from '../../core/capture/queryContext.js';
import { followUps } from '../../core/requests/followUps.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { prettyText, queryParamsOf, truncate, valueAt } from '../../shared/format.js';
import { Button } from '../components/Button.js';
import { CodeBlock } from '../components/CodeBlock.js';
import { KeyValues } from '../components/KeyValues.js';
import { Muted } from '../components/Muted.js';
import { Section } from '../components/Section.js';
import type { Focus } from '../contexts.js';
import { useRecords } from '../hooks/useRecords.js';
import { ClassBadge } from './ClassBadge.js';
import { ConsumerList } from './ConsumerList.js';
import { FetchCause } from './FetchCause.js';
import { StackSection } from './StackSection.js';
import { RequestStatusLine } from './RequestSummary.js';

// 아주 큰 응답을 그대로 그리면 패널이 멈추므로 상세 화면에서는 이만큼만 보여 준다(복사도 같은 내용).
const MAX_DETAIL_TEXT = 200_000;

const TRIGGER_TEXT: Record<NonNullable<RequestRecord['trigger']>, string> = {
  focus: '창 포커스·탭 전환 직후에 나간 요청입니다(라이브러리의 자동 재요청).',
  reconnect: '네트워크 재연결 직후에 나간 요청입니다.',
};

const requestBodyText = (record: RequestRecord): string | undefined =>
  record.requestBody === undefined ? undefined : prettyText(record.requestBody);

// 파싱된 응답 객체가 있으면 그것을 정렬해 보여 준다. 원문은 100KB 에서 잘려 JSON 으로 다시 읽히지 않을 수 있다.
const responseBodyText = (record: RequestRecord): string | undefined => {
  if (record.body !== undefined) return truncate(JSON.stringify(record.body, null, 2) ?? '', MAX_DETAIL_TEXT);
  return record.responseText === undefined ? undefined : prettyText(record.responseText);
};

const RequestBodySection = ({ record }: { record: RequestRecord }) => {
  const text = requestBodyText(record);
  const content = record.bodyUnreadable ? (
    <Muted>(Blob·스트림처럼 바로 읽을 수 없는 본문)</Muted>
  ) : text === undefined ? (
    <Muted>(없음)</Muted>
  ) : (
    <CodeBlock text={text} />
  );
  return (
    <Section title="Request Body" copy={text}>
      {content}
    </Section>
  );
};

const ResponseBodySection = ({ record }: { record: RequestRecord }) => {
  const { body, responseText } = record;
  // 폴링 화면에서는 요청이 들어올 때마다 패널이 다시 그려진다. 큰 응답을 그때마다 직렬화하지 않는다.
  // 본문은 상세를 연 뒤에 도착할 수 있어 body·responseText 가 바뀔 때만 다시 만든다.
  const text = useMemo(() => responseBodyText({ ...record, body, responseText }), [record, body, responseText]);
  return (
    <Section title="Response Body" copy={text}>
      {text === undefined ? <Muted>(텍스트가 아닌 응답이거나 아직 받지 못했습니다)</Muted> : <CodeBlock text={text} />}
    </Section>
  );
};

const RepeatInfo = ({ record }: { record: RequestRecord }) => (
  <div style={{ marginTop: 4 }}>
    <ClassBadge record={record} />
    {record.duplicateOf && <Muted>앞선 요청 #{record.duplicateOf}</Muted>}
    {record.sameResponseAs && <Muted>같은 응답 #{record.sameResponseAs}</Muted>}
    {record.repeatCause && <Muted>다시 나간 이유: {record.repeatCause.detail}</Muted>}
  </div>
);

// 스택이 끊겨도 React Query 를 거쳤으면 어느 훅이 불렀는지 보여 주고, 아니면 모른다고 밝힌다.
const QueryCaller = ({ record }: { record: RequestRecord }) => {
  const query = useMemo(() => queryContextOf(record), [record]);
  if (query)
    return (
      <Muted>
        React Query {query.queryKey}
        {query.observer && ` · ${query.observer}`}
      </Muted>
    );
  return record.noAppFrame ? <Muted>보낸 앱 코드를 찾지 못했습니다(비동기 경계에서 스택이 끊김)</Muted> : null;
};

// 변경 요청 뒤 1초 안에 다시 나간 조회. 근거는 시간 근접이고, React Query 면 queryKey 를 덧붙인다.
const FollowUps = ({ record }: { record: RequestRecord }) => {
  // 뒤따르는 조회는 상세를 연 뒤에도 끝나므로 기록이 바뀔 때마다 다시 센다.
  const records = useRecords();
  const list = useMemo(() => followUps(record, records, (r) => queryContextOf(r)?.queryKey), [record, records]);
  if (!list.length) return null;
  return (
    <Section title="이 요청 뒤에 다시 받은 요청 (1초 안, 시간 근접)">
      {list.map((f) => (
        <div key={f.endpoint}>
          {f.endpoint} ×{f.count}
          {f.queryKey && <Muted>React Query {f.queryKey}</Muted>}
          {f.sameResponse > 0 && <Muted>같은 응답 {f.sameResponse}건(무효화 범위가 넓을 수 있음)</Muted>}
          {f.periodic && <Muted>주기 요청(변경과 무관할 수 있음)</Muted>}
        </div>
      ))}
    </Section>
  );
};

/** 요청 상세: 컴포넌트가 쓰는 데이터, 쓰는 컴포넌트, 보낸 코드, Query, 헤더, 본문 */
export const RequestDetail = ({ record, focus, onBack }: { record: RequestRecord; focus?: Focus; onBack: () => void }) => (
  <div>
    <Button onClick={onBack}>← 뒤로</Button>
    <div style={{ marginTop: 8 }}>
      <b>{record.method}</b> {record.url}
    </div>
    <RequestStatusLine record={record} />
    <RepeatInfo record={record} />
    {focus && (
      <Section title={`이 컴포넌트가 쓰는 데이터: ${focus.path} ← ${focus.via}`}>
        <CodeBlock text={JSON.stringify(valueAt(record.body, focus.path), null, 2) ?? '(값 없음)'} />
      </Section>
    )}
    {record.trigger && <Muted>{TRIGGER_TEXT[record.trigger]}</Muted>}
    <ConsumerList record={record} />
    <QueryCaller record={record} />
    <FetchCause record={record} />
    <FollowUps record={record} />
    {record.stack && <StackSection stack={record.sourceStack ?? record.stack} />}
    <Section title="Query">
      <KeyValues values={queryParamsOf(record.url)} />
    </Section>
    <Section title="Request Headers">
      <KeyValues values={record.requestHeaders} />
    </Section>
    <RequestBodySection record={record} />
    <Section title="Response Headers">
      <KeyValues values={record.responseHeaders} />
    </Section>
    <ResponseBodySection record={record} />
  </div>
);
