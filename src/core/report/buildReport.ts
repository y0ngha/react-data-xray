import { renderAdvice } from '../render/advice.js';
import { groupRenders, sortRenderGroups } from '../render/groups.js';
import { getTopRenders } from '../render/monitor.js';
import { RENDER_REASONS } from '../render/types.js';
import { classifyRecords, isWaste } from '../requests/classify.js';
import { getEndpointStats } from '../requests/endpointStats.js';
import { endpointOf } from '../requests/requestKey.js';
import { getRecords } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { groupBy } from '../../shared/collections.js';

const MAX_RENDER_GROUPS = 30;
const MAX_CALLERS = 3;
const MAX_EXAMPLES = 3;

/** AI·사람이 읽는 rdx 결과 요약. 응답 본문과 헤더는 넣지 않는다(인증 정보가 섞일 수 있다). */
export interface RdxReport {
  generatedAt: string;
  page: string;
  howToRead: string[];
  requests: {
    total: number;
    endpoints: Array<{
      endpoint: string;
      count: number;
      avgMs: number;
      duplicates: number;
      sameResponses: number;
      review: number;
      /** 요청을 보낸 앱 코드 위치(호출 스택 앞쪽 3줄)와 그 위치에서 보낸 수 */
      callers: Array<{ frame: string; count: number }>;
      /** 낭비로 판정된 요청의 URL 예(쿼리 포함) */
      wasteExamples: string[];
    }>;
  };
  renders: {
    monitoring: boolean;
    components: Array<{
      name: string;
      instances: number;
      renders: number;
      avoidable: number;
      memoized: boolean;
      reasons: Record<string, number>;
      changedProps: { sameContent: string[]; newCallback: string[]; context: string[] };
      networkCauses: Array<{ endpoint: string; direct: number; viaParent: number }>;
      advice: string[];
    }>;
  };
}

const HOW_TO_READ = [
  'requests.endpoints 는 낭비(duplicates: 2초 안 같은 요청, sameResponses: 직전과 똑같은 응답) 많은 순이다.',
  'review 는 주기 요청·포커스 재요청처럼 의도일 수 있지만 점검할 반복이다.',
  'callers 의 줄 번호는 dev 서버가 변환한 코드 기준이라 원본과 몇십 줄 어긋날 수 있다. 함수 이름으로 찾는다.',
  'renders.components 는 최근 10초 렌더를 컴포넌트 이름별로 합친 것이고, 줄일 수 있는 렌더 많은 순이다.',
  'networkCauses 의 viaParent 는 조상이 응답으로 렌더돼서 따라 렌더된 횟수다. 고칠 곳은 대개 그 조상의 setState 다.',
];

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
    .join(' <- ') || undefined;

const callersOf = (records: readonly RequestRecord[]) => {
  const counts = records.reduce((acc, r) => {
    const frame = callerOf(r.stack);
    return frame ? acc.set(frame, (acc.get(frame) ?? 0) + 1) : acc;
  }, new Map<string, number>());
  return Array.from(counts, ([frame, count]) => ({ frame, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_CALLERS);
};

const nonZero = (reasons: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(reasons).filter(([, n]) => n > 0));

/** 지금까지 모은 요청과 렌더를 요약한다. */
export const buildReport = (monitoring: boolean, now = Date.now()): RdxReport => {
  const records = getRecords();
  const classes = classifyRecords(records, new Set());
  const byEndpoint = groupBy(records, endpointOf);
  const groups = sortRenderGroups(groupRenders(getTopRenders(500, now)), 'avoidable').slice(0, MAX_RENDER_GROUPS);
  return {
    generatedAt: new Date(now).toISOString(),
    page: typeof location === 'undefined' ? '' : location.pathname,
    howToRead: HOW_TO_READ,
    requests: {
      total: records.length,
      endpoints: getEndpointStats(records, classes).map((s) => {
        const own = byEndpoint.get(s.endpoint) ?? [];
        return {
          endpoint: s.endpoint,
          count: s.count,
          avgMs: s.avgMs,
          duplicates: s.duplicates,
          sameResponses: s.sameResponses,
          review: s.review,
          callers: callersOf(own),
          wasteExamples: Array.from(new Set(own.filter((r) => isWaste(classes.get(r.id))).map((r) => r.url))).slice(0, MAX_EXAMPLES),
        };
      }),
    },
    renders: {
      monitoring,
      components: groups.map((g) => ({
        name: g.name,
        instances: g.instances,
        renders: g.recent,
        avoidable: g.avoidable,
        memoized: g.memoized,
        reasons: nonZero(Object.fromEntries(RENDER_REASONS.map((r) => [r, g.reasons[r]]))),
        changedProps: { sameContent: g.sameContentKeys, newCallback: g.callbackKeys, context: g.contextKeys },
        networkCauses: g.causes.map((c) => ({ endpoint: endpointOf(c.record), direct: c.direct, viaParent: c.parent })),
        advice: renderAdvice(g),
      })),
    },
  };
};
