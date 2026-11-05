import { pinnedRefetchReason } from '../../core/reactQuery/refetchReason.js';
import { CLASS_LABEL, isFailed, isWaste } from '../../core/requests/classify.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { Badge } from '../components/Badge.js';
import { useRequestActions } from '../contexts.js';
import { classColor, color } from '../theme.js';

const shorten = (label: string) => label.replace(' refetch', '').replace(' request', '');

/** 요청 분류 배지. 낭비는 빨강, 확인 필요는 노랑, 정상은 회색. 분류가 없으면 그리지 않는다. */
export const ClassBadge = ({ record, short = false }: { record: RequestRecord; short?: boolean }) => {
  const c = useRequestActions().classOf(record);
  if (c === 'ok') return null;
  const label = short ? shorten(CLASS_LABEL[c]) : CLASS_LABEL[c];
  // 색과 분류는 그대로 두고 표기만 더한다. 실패 응답의 중복은 코드가 아니라 재시도·환경 때문일 수 있다.
  // 같은 응답이 staleTime 0 때문이면 고칠 대상이라 원인을 붙인다(빨강 그대로).
  const note = c === 'same-response' && pinnedRefetchReason(record) === 'stale-zero' ? ' · staleTime 0' : '';
  return <Badge color={classColor(c)}>{(isWaste(c) && isFailed(record) ? `${label} · failed response` : label) + note}</Badge>;
};

export const UNUSED_TITLE =
  'No component was found holding this response a few seconds after it arrived. Data used only in effects or event handlers, or transformed into new objects, also looks unused — check the code.';

/** 쓰지 않는 응답 배지(노랑, 확인 필요). 반복 분류와 따로 붙는다. 판정하지 않았거나 쓰는 컴포넌트가 있으면 그리지 않는다. */
export const UnusedBadge = ({ record }: { record: RequestRecord }) =>
  record.unused ? (
    <span title={UNUSED_TITLE}>
      <Badge color={color.review}>unused</Badge>
    </span>
  ) : null;
