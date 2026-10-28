import { queueIndex } from '../inspect/derivedMatch.js';
import { flushQueue } from '../scheduler/idleQueue.js';
import { classifyRecords } from '../requests/classify.js';
import { getRecords } from '../requests/store.js';
import { readIgnoredEndpoints } from '../../shared/ignoredEndpoints.js';
import {
  buildReactQuerySection,
  REACT_QUERY_HOW_TO_READ,
  REACT_QUERY_HOW_TO_READ_EXTRA,
  type ReactQuerySection,
} from './reactQuerySection.js';
import { buildRenderSection, RENDER_HOW_TO_READ, RENDER_HOW_TO_READ_EXTRA, type RenderSection } from './renderSection.js';
import { buildRequestSection, REQUEST_HOW_TO_READ, REQUEST_HOW_TO_READ_EXTRA, type RequestSection } from './requestSection.js';

/** AI·사람이 읽는 rdx 결과 요약. 응답 본문과 헤더는 넣지 않는다(인증 정보가 섞일 수 있다). */
export interface RdxReport {
  generatedAt: string;
  page: string;
  howToRead: string[];
  requests: RequestSection;
  reactQuery: ReactQuerySection;
  renders: RenderSection;
}

// 섹션별 줄을 읽는 순서로 잇는다.
const HOW_TO_READ = [
  REQUEST_HOW_TO_READ.waste,
  REQUEST_HOW_TO_READ.review,
  REQUEST_HOW_TO_READ.ignored,
  REQUEST_HOW_TO_READ.restored,
  REQUEST_HOW_TO_READ.callers,
  RENDER_HOW_TO_READ.window,
  REQUEST_HOW_TO_READ.dropped,
  REACT_QUERY_HOW_TO_READ,
  RENDER_HOW_TO_READ.viaParent,
  RENDER_HOW_TO_READ.byTiming,
  RENDER_HOW_TO_READ.sameResponse,
  RENDER_HOW_TO_READ.causedBy,
  RENDER_HOW_TO_READ.stateChanges,
  RENDER_HOW_TO_READ.startedRenders,
  ...REQUEST_HOW_TO_READ_EXTRA,
  ...RENDER_HOW_TO_READ_EXTRA,
  ...REACT_QUERY_HOW_TO_READ_EXTRA,
];

/** 지금까지 모은 요청과 렌더를 요약한다. drain 이 false 면(주기적인 업로드) 미뤄 둔 분석을 기다리지 않고 지금까지 끝난 것만 담는다. */
export const buildReport = (monitoring: boolean, now = Date.now(), drain = true): RdxReport => {
  // 사용자가 직접 묻는 조회는 미뤄 둔 분석을 먼저 마친다.
  if (drain) {
    queueIndex(); // 모든 기록의 색인 일을 큐에 올린 뒤
    flushQueue();
  }
  const records = getRecords();
  // 패널에서 "의도된 반복"으로 지정한 엔드포인트는 보고서에서도 낭비로 세지 않는다.
  const ignored = readIgnoredEndpoints();
  const classes = classifyRecords(records, ignored);
  return {
    generatedAt: new Date(now).toISOString(),
    page: typeof location === 'undefined' ? '' : location.pathname,
    howToRead: HOW_TO_READ,
    requests: buildRequestSection(records, classes, ignored),
    reactQuery: buildReactQuerySection(records, classes),
    renders: buildRenderSection(monitoring, now),
  };
};
