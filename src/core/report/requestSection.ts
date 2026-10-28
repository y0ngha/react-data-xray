import { isWaste, type RequestClass } from '../requests/classify.js';
import { getEndpointStats } from '../requests/endpointStats.js';
import { endpointOf } from '../requests/requestKey.js';
import { redactUrl } from '../requests/sessionRecords.js';
import { getDroppedCount } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { groupBy } from '../../shared/collections.js';

const MAX_CALLERS = 3;
const MAX_EXAMPLES = 3;

export interface RequestSection {
  total: number;
  /** 기록 상한(200건)을 넘어 빠진 요청 수(reset 뒤부터) */
  dropped: number;
  endpoints: Array<{
    endpoint: string;
    /** 사용자가 의도된 반복으로 지정해 낭비로 세지 않은 엔드포인트 */
    ignored: boolean;
    count: number;
    /** 그중 새로고침 전 페이지의 요청 수 */
    restoredCount: number;
    avgMs: number;
    duplicates: number;
    sameResponses: number;
    review: number;
    /** 요청을 보낸 앱 코드 위치(호출 스택 앞쪽 3줄)와 그 위치에서 보낸 수 */
    callers: Array<{ frame: string; count: number }>;
    /** 낭비로 판정된 요청의 URL 예(쿼리 포함) */
    wasteExamples: string[];
  }>;
}

/** 순서는 buildReport 가 다른 섹션 줄과 맞춘다. */
export const REQUEST_HOW_TO_READ = {
  waste: 'requests.endpoints 는 낭비(duplicates: 2초 안 같은 요청, sameResponses: 직전과 똑같은 응답) 많은 순이다.',
  review: 'review 는 주기 요청·포커스 재요청처럼 의도일 수 있지만 점검할 반복이다.',
  ignored: 'ignored: true 인 엔드포인트는 사용자가 의도된 반복으로 지정한 것이라 고치지 않는다.',
  restored: '요청 집계에는 같은 탭에서 새로고침하기 전의 요청도 들어 있다. 새로고침 전후를 가르려면 restoredCount 를 본다.',
  callers:
    'callers 는 소스맵으로 원본 위치(src/…:줄:열)로 바꾼 것이다. http 주소로 남은 줄은 소스맵이 없어 변환된 코드 기준이라 줄 번호가 어긋날 수 있으니 함수 이름으로 찾는다.',
  dropped: 'requests.dropped 가 0 보다 크면 기록 상한(200건)을 넘어 오래된 요청이 빠진 것이다. 전후 비교는 시나리오를 짧게 나눠 다시 잰다.',
};

// 첫 줄은 대개 앱의 공통 fetch 함수라 그것만으로는 어디서 보냈는지 모른다. 바깥으로 몇 줄 더 본다.
const CALLER_FRAMES = 3;

/** 호출 스택의 앞쪽 몇 줄(rdx 프레임은 기록할 때 이미 뺐다) */
const callerOf = (stack: string | undefined): string | undefined =>
  stack
    ?.split('\n')
    .map((line) => line.trim())
    // V8: "at fn (url:1:2)", Firefox·Safari: "fn@url:1:2"
    .filter((line) => line.startsWith('at ') || /@.+:\d+:\d+$/.test(line))
    .slice(0, CALLER_FRAMES)
    // dev 서버가 파일을 고칠 때마다 붙이는 ?t=·?v= 를 뗀다. 그래야 같은 호출 위치가 고칠 때마다 갈라지지 않는다.
    .map((line) => line.replace(/\?[^\s:)]*(?=:\d+:\d+)/g, ''))
    .join(' <- ') || undefined;

const callersOf = (records: readonly RequestRecord[]) => {
  const counts = records.reduce((acc, r) => {
    const frame = callerOf(r.sourceStack ?? r.stack);
    return frame ? acc.set(frame, (acc.get(frame) ?? 0) + 1) : acc;
  }, new Map<string, number>());
  return Array.from(counts, ([frame, count]) => ({ frame, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_CALLERS);
};

export const buildRequestSection = (
  records: readonly RequestRecord[],
  classes: ReadonlyMap<number, RequestClass>,
  ignored: ReadonlySet<string>,
): RequestSection => {
  const byEndpoint = groupBy(records, endpointOf);
  return {
    total: records.length,
    dropped: getDroppedCount(),
    endpoints: getEndpointStats(records, classes).map((s) => {
      const own = byEndpoint.get(s.endpoint) ?? [];
      return {
        endpoint: s.endpoint,
        ignored: ignored.has(s.endpoint),
        count: s.count,
        restoredCount: own.filter((r) => r.restored).length,
        avgMs: s.avgMs,
        duplicates: s.duplicates,
        sameResponses: s.sameResponses,
        review: s.review,
        callers: callersOf(own),
        wasteExamples: Array.from(new Set(own.filter((r) => isWaste(classes.get(r.id))).map((r) => redactUrl(r.url)))).slice(
          0,
          MAX_EXAMPLES,
        ),
      };
    }),
  };
};

// 새 howToRead 줄은 여기에 더한다.
export const REQUEST_HOW_TO_READ_EXTRA: readonly string[] = [];
