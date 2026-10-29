import type { RequestRecord } from '../../core/requests/types.js';
import { queryOf, safeDecode, truncate } from '../../shared/format.js';
import { Muted } from '../components/Muted.js';

/** 같은 엔드포인트라도 쿼리·payload 가 다를 수 있어 함께 보여 준다. */
export const RequestParams = ({ record }: { record: RequestRecord }) => {
  const query = queryOf(record.url);
  return (
    <>
      {query && <Muted>query: {truncate(safeDecode(query))}</Muted>}
      {record.requestBody && <Muted>payload: {truncate(record.requestBody)}</Muted>}
      {record.bodyUnreadable && <Muted>payload: (body not readable, excluded from duplicate detection)</Muted>}
    </>
  );
};
