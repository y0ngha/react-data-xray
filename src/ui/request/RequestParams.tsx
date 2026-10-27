import type { RequestRecord } from '../../core/requests/types.js';
import { queryOf, truncate } from '../../shared/format.js';
import { Muted } from '../components/Muted.js';

/** 같은 엔드포인트라도 쿼리·payload 가 다를 수 있어 함께 보여 준다. */
export const RequestParams = ({ record }: { record: RequestRecord }) => {
  const query = queryOf(record.url);
  return (
    <>
      {query && <Muted>query: {truncate(decodeURIComponent(query))}</Muted>}
      {record.requestBody && <Muted>payload: {truncate(record.requestBody)}</Muted>}
      {record.bodyUnreadable && <Muted>payload: (읽을 수 없는 본문, 중복 판정 제외)</Muted>}
    </>
  );
};
