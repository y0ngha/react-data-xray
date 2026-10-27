import { CLASS_LABEL } from '../../core/requests/classify.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { Badge } from '../components/Badge.js';
import { useRequestActions } from '../contexts.js';
import { classColor } from '../theme.js';

const shorten = (label: string) => label.replace(' 재요청', '').replace(' 요청', '');

/** 요청 분류 배지. 낭비는 빨강, 확인 필요는 노랑, 정상은 회색. 분류가 없으면 그리지 않는다. */
export const ClassBadge = ({ record, short = false }: { record: RequestRecord; short?: boolean }) => {
  const c = useRequestActions().classOf(record);
  if (c === 'ok') return null;
  return <Badge color={classColor(c)}>{short ? shorten(CLASS_LABEL[c]) : CLASS_LABEL[c]}</Badge>;
};
