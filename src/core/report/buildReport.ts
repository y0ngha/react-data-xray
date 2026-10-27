import { auditQueryCache, CACHE_FINDING_TEXT, findQueryClients, type CacheFinding } from '../reactQuery/cacheAudit.js';
import { renderAdvice } from '../render/advice.js';
import { groupRenders, sortRenderGroups } from '../render/groups.js';
import { getTopRenders, reportWindowMs } from '../render/monitor.js';
import { RENDER_REASONS } from '../render/types.js';
import { classifyRecords, isWaste } from '../requests/classify.js';
import { getEndpointStats } from '../requests/endpointStats.js';
import { endpointOf } from '../requests/requestKey.js';
import { getDroppedCount, getRecords } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { groupBy } from '../../shared/collections.js';
import { readIgnoredEndpoints } from '../../shared/ignoredEndpoints.js';

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
  };
  /** React Query 캐시키 설계 점검. 화면에 QueryClientProvider 가 없으면 found: false */
  reactQuery: {
    found: boolean;
    findings: Array<CacheFinding & { title: string; fix: string }>;
  };
  renders: {
    monitoring: boolean;
    /** renders.components 가 센 구간(초) */
    windowSeconds: number;
    components: Array<{
      name: string;
      instances: number;
      renders: number;
      avoidable: number;
      memoized: boolean;
      reasons: Record<string, number>;
      changedProps: { sameContent: string[]; newCallback: string[]; context: string[] };
      /** 이 컴포넌트를 그리는 JSX 위치(dev 빌드가 기록할 때) */
      renderedAt?: string;
      /** 조상 때문에 렌더됐다면 그 렌더를 시작한 조상(이름·이유). 고칠 곳은 대개 이 조상이다 */
      causedBy: Array<{ name: string; reason: string; count: number }>;
      networkCauses: Array<{ endpoint: string; direct: number; viaParent: number; fromSameResponse: number }>;
      advice: string[];
    }>;
  };
}

const HOW_TO_READ = [
  'requests.endpoints 는 낭비(duplicates: 2초 안 같은 요청, sameResponses: 직전과 똑같은 응답) 많은 순이다.',
  'review 는 주기 요청·포커스 재요청처럼 의도일 수 있지만 점검할 반복이다.',
  'ignored: true 인 엔드포인트는 사용자가 의도된 반복으로 지정한 것이라 고치지 않는다.',
  '요청 집계에는 같은 탭에서 새로고침하기 전의 요청도 들어 있다. 새로고침 전후를 가르려면 restoredCount 를 본다.',
  'callers 는 소스맵으로 원본 위치(src/…:줄:열)로 바꾼 것이다. http 주소로 남은 줄은 소스맵이 없어 변환된 코드 기준이라 줄 번호가 어긋날 수 있으니 함수 이름으로 찾는다.',
  'renders.components 는 renders.windowSeconds 동안(reset 했으면 그 뒤 최대 2분, 아니면 최근 10초)의 렌더를 컴포넌트 이름별로 합친 것이고, 줄일 수 있는 렌더 많은 순이다. 컴포넌트마다 최근 200회까지만 센다.',
  'requests.dropped 가 0 보다 크면 기록 상한(200건)을 넘어 오래된 요청이 빠진 것이다. 전후 비교는 시나리오를 짧게 나눠 다시 잰다.',
  'reactQuery.findings 는 queryKey 설계 문제다(중복 캐시, 키에 빠진 파라미터, 빗나간 무효화, staleTime 0). fix 를 따른다.',
  'networkCauses 의 viaParent 는 조상이 응답으로 렌더돼서 따라 렌더된 횟수다. 고칠 곳은 대개 그 조상의 setState 다.',
  'networkCauses 의 fromSameResponse 는 직전과 똑같은 응답인데도 렌더된 횟수다. 같은 응답이면 setState 를 건너뛰거나 구조적 공유를 쓴다.',
  'causedBy 는 그 렌더를 시작한 조상(이름·이유)이다. renderedAt 은 이 컴포넌트를 그리는 JSX 위치다.',
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

const nonZero = (reasons: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(reasons).filter(([, n]) => n > 0));

/** 지금까지 모은 요청과 렌더를 요약한다. */
export const buildReport = (monitoring: boolean, now = Date.now()): RdxReport => {
  const records = getRecords();
  // 패널에서 "의도된 반복"으로 지정한 엔드포인트는 보고서에서도 낭비로 세지 않는다.
  const ignored = readIgnoredEndpoints();
  const classes = classifyRecords(records, ignored);
  const byEndpoint = groupBy(records, endpointOf);
  const windowMs = reportWindowMs(now);
  const clients = findQueryClients();
  const groups = sortRenderGroups(groupRenders(getTopRenders(500, now, undefined, windowMs)), 'avoidable').slice(0, MAX_RENDER_GROUPS);
  return {
    generatedAt: new Date(now).toISOString(),
    page: typeof location === 'undefined' ? '' : location.pathname,
    howToRead: HOW_TO_READ,
    requests: {
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
          wasteExamples: Array.from(new Set(own.filter((r) => isWaste(classes.get(r.id))).map((r) => r.url))).slice(0, MAX_EXAMPLES),
        };
      }),
    },
    reactQuery: {
      found: clients.length > 0,
      findings: auditQueryCache((r) => classes.get(r.id) ?? 'ok', records, clients).map((f) =>
        Object.assign({}, f, CACHE_FINDING_TEXT[f.kind]),
      ),
    },
    renders: {
      monitoring,
      windowSeconds: Math.round(windowMs / 1000),
      components: groups.map((g) => ({
        name: g.name,
        instances: g.instances,
        renders: g.recent,
        avoidable: g.avoidable,
        memoized: g.memoized,
        reasons: nonZero(Object.fromEntries(RENDER_REASONS.map((r) => [r, g.reasons[r]]))),
        changedProps: { sameContent: g.sameContentKeys, newCallback: g.callbackKeys, context: g.contextKeys },
        renderedAt: g.location,
        causedBy: g.origins,
        networkCauses: g.causes.map((c) => ({
          endpoint: endpointOf(c.record),
          direct: c.direct,
          viaParent: c.parent,
          fromSameResponse: c.sameResponse,
        })),
        advice: renderAdvice(g),
      })),
    },
  };
};
