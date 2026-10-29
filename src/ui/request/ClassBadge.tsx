import { pinnedRefetchReason } from '../../core/reactQuery/refetchReason.js';
import { classLabel, isFailed, isWaste } from '../../core/requests/classify.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { Badge } from '../components/Badge.js';
import { useRequestActions } from '../contexts.js';
import { useLang } from '../i18n.js';
import { classColor } from '../theme.js';

const shorten = (label: string, ko: boolean) =>
  ko ? label.replace(' 재요청', '').replace(' 요청', '') : label.replace(' refetch', '').replace(' request', '');

/** 요청 분류 배지. 낭비는 빨강, 확인 필요는 노랑, 정상은 회색. 분류가 없으면 그리지 않는다. */
export const ClassBadge = ({ record, short = false }: { record: RequestRecord; short?: boolean }) => {
  const lang = useLang();
  const c = useRequestActions().classOf(record);
  if (c === 'ok') return null;
  const full = classLabel(c, lang);
  const label = short ? shorten(full, lang === 'ko') : full;
  // 색과 분류는 그대로 두고 표기만 더한다. 실패 응답의 중복은 코드가 아니라 재시도·환경 때문일 수 있다.
  // 같은 응답이 staleTime 0 때문이면 고칠 대상이라 원인을 붙인다(빨강 그대로).
  const note = c === 'same-response' && pinnedRefetchReason(record) === 'stale-zero' ? ' · staleTime 0' : '';
  const failNote = lang === 'ko' ? '실패 응답' : 'failed response';
  return <Badge color={classColor(c)}>{(isWaste(c) && isFailed(record) ? `${label} · ${failNote}` : label) + note}</Badge>;
};
