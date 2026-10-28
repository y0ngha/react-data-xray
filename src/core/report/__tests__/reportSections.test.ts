import { describe, expect, it } from 'vitest';

import { buildReport } from '../buildReport.js';

// 섹션 파일로 나누기 전 howToRead 14줄. 내용과 순서를 고정한다.
const ORIGINAL_HOW_TO_READ: string[] = [
  'requests.endpoints 는 낭비(duplicates: 2초 안 같은 요청, sameResponses: 직전과 똑같은 응답) 많은 순이다.',
  'review 는 주기 요청·포커스 재요청처럼 의도일 수 있지만 점검할 반복이다.',
  'ignored: true 인 엔드포인트는 사용자가 의도된 반복으로 지정한 것이라 고치지 않는다.',
  '요청 집계에는 같은 탭에서 새로고침하기 전의 요청도 들어 있다. 새로고침 전후를 가르려면 restoredCount 를 본다.',
  'callers 는 소스맵으로 원본 위치(src/…:줄:열)로 바꾼 것이다. http 주소로 남은 줄은 소스맵이 없어 변환된 코드 기준이라 줄 번호가 어긋날 수 있으니 함수 이름으로 찾는다.',
  'renders.components 는 renders.windowSeconds 동안(reset 했으면 그 뒤 최대 2분, 아니면 최근 10초)의 렌더를 컴포넌트 이름별로 합친 것이고, 줄일 수 있는 렌더 많은 순이다. 컴포넌트마다 최근 200회까지만 센다.',
  'requests.dropped 가 0 보다 크면 기록 상한(200건)을 넘어 오래된 요청이 빠진 것이다. 전후 비교는 시나리오를 짧게 나눠 다시 잰다.',
  'reactQuery.findings 는 queryKey 설계 문제다(중복 캐시, 키에 빠진 파라미터, 빗나간 무효화, staleTime 0). fix 를 따른다.',
  'networkCauses 의 viaParent 는 조상이 응답으로 렌더돼서 따라 렌더된 횟수다. 고칠 곳은 대개 그 조상의 setState 다.',
  'networkCauses 의 byTiming 은 응답 객체는 찾지 못했지만(가공해 넣음) 응답 도착 직후 자기 state 가 바뀐 횟수다(시간으로 추정).',
  'networkCauses 의 fromSameResponse 는 직전과 똑같은 응답인데도 렌더된 횟수다. 같은 응답이면 setState 를 건너뛰거나 구조적 공유를 쓴다.',
  'causedBy 는 그 렌더를 시작한 조상(이름·이유)이다. renderedAt 은 이 컴포넌트를 그리는 JSX 위치다.',
  'stateChanges 는 state 때문에 렌더됐을 때 값이 바뀐 훅(종류 #순서)과 횟수, 일정한 간격(intervalMs, 타이머 신호), 최근 변경이다.',
  'startedRenders 는 이 컴포넌트가 시작한 렌더가 하위에 미친 영향이다. unchanged 가 크고 changedProps 가 적으면, 바뀌는 state 를 changedProps 의 마지막 컴포넌트 가까이로 내리는 것이 해법이다(advice 첫 줄).',
];

describe('보고서 섹션 분리', () => {
  it('how_to_read_order: howToRead 는 분리 전 14줄과 내용·순서가 같다', () => {
    expect(buildReport(false, 0, false).howToRead).toEqual(ORIGINAL_HOW_TO_READ);
  });
});
