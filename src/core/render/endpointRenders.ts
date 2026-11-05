import { endpointOf } from '../requests/requestKey.js';
import { round1 } from '../../shared/format.js';
import type { RequestRecord } from '../requests/types.js';
import type { RenderEntry } from './types.js';

/** 렌더 수와 자기 렌더 시간 합(ms, selfBaseDuration). 시간이 기록된 렌더가 하나도 없으면 ms 는 없다. */
export interface RenderCost {
  count: number;
  ms?: number;
}

/**
 * 엔드포인트 하나의 응답이 일으킨 렌더. count·ms 는 직접(응답 객체를 받았거나 응답 직후 자기 state 가 바뀜)과
 * 부모를 따라 렌더된 자손(viaParent)을 모두 합친 값이다. fromSameResponse 는 그중 직전과 똑같은 응답으로 일어난 렌더다.
 */
export interface EndpointRenders extends RenderCost {
  viaParent: RenderCost;
  fromSameResponse: RenderCost;
}

// 유휴 큐 한 step 이 4ms 를 넘기지 않게 이만큼 일할 때마다 컴포넌트 사이에서 쉰다(한 컴포넌트의 기록은 최대 200개라 한 번에 본다).
const WORK_CHUNK = 2000;
// 컴포넌트 하나를 보는(구간 확인·거르기) 일을 렌더 기록 몇 개 보는 것으로 칠지
const ENTRY_WORK = 10;

/** 묶음 하나(전체·부모를 따라·같은 응답)의 합. 시간이 기록된 렌더 수는 묶음마다 센다. */
interface Bucket {
  count: number;
  ms: number;
  timed: number;
}

const bucket = (): Bucket => ({ count: 0, ms: 0, timed: 0 });

const add = (b: Bucket, ms: number | undefined): void => {
  b.count++;
  if (ms === undefined) return;
  b.ms += ms;
  b.timed++;
};

// 그 묶음의 렌더 중 시간이 기록된 것이 없으면 ms 를 두지 않는다(0ms 와 "모름"을 가른다).
const cost = (b: Bucket): RenderCost => (b.timed > 0 ? { count: b.count, ms: round1(b.ms) } : { count: b.count });

/** since 뒤(기록은 시간순이라 끝에서부터) 렌더 수 */
const recentCount = (entry: RenderEntry, since: number): number => {
  const { events } = entry;
  let n = 0;
  for (let i = events.length - 1; i >= 0 && events[i].time >= since; i--) n++;
  return n;
};

export interface EndpointRendersOptions {
  /** 분석 대상 안의 컴포넌트만 센다 */
  keep?: (entry: RenderEntry) => boolean;
  /** 이 요청이 원인인 렌더만 센다(화면·보고서가 보여 주는 요청과 맞춘다) */
  include?: (record: RequestRecord) => boolean;
  /** 렌더 그룹과 같은 인스턴스 상한. 넘으면 구간 렌더가 적은 인스턴스를 뺀다(getRenderGroups 와 같은 규칙) */
  maxInstances?: number;
}

/**
 * since 뒤 렌더 기록 중 원인 요청(cause.record)이 있는 것을 그 요청의 엔드포인트(endpointOf)별로 모은다.
 * 기록은 이미 유휴 큐에서 만든 것이라 여기서는 세기만 하고, 컴포넌트 사이에서만 yield 한다(주기 화면은 큐에서, 보고서는 그 자리에서 돌린다).
 * 한 컴포넌트의 기록을 보다 멈추지 않는다: 쉬는 동안 commit 이 기록을 밀어내거나(200개 상한) reset 이 비우면 같은 렌더를 두 번 센다.
 */
export function* countEndpointRendersSteps(
  entries: readonly RenderEntry[],
  since: number,
  { keep = () => true, include = () => true, maxInstances = Infinity }: EndpointRendersOptions = {},
): Generator<void, Map<string, EndpointRenders>> {
  let work = 0;
  const rest = function* (amount: number): Generator<void> {
    work += amount;
    if (work < WORK_CHUNK) return;
    work = 0;
    yield;
  };
  // 1) 구간 안 렌더가 있는 분석 대상 인스턴스와 그 수. 거른 것도 일로 센다.
  let kept: Array<{ entry: RenderEntry; recent: number }> = [];
  for (const entry of entries) {
    const recent = recentCount(entry, since);
    if (recent > 0 && keep(entry)) kept.push({ entry, recent });
    yield* rest(ENTRY_WORK + recent);
  }
  if (kept.length > maxInstances) kept = kept.sort((a, b) => b.recent - a.recent).slice(0, maxInstances);
  // 2) 원인 요청의 엔드포인트별로 센다. 한 응답이 여러 컴포넌트를 렌더하므로 엔드포인트 이름(GraphQL 본문을 읽을 수 있다)은 요청마다 한 번만 만든다.
  const acc = new Map<string, { all: Bucket; parent: Bucket; same: Bucket }>();
  const names = new Map<RequestRecord, string | null>();
  for (const { entry } of kept) {
    const { events } = entry;
    let seen = 0;
    for (let i = events.length - 1; i >= 0 && events[i].time >= since; i--) {
      seen++;
      const { cause, ms } = events[i];
      if (!cause) continue;
      let name = names.get(cause.record);
      if (name === undefined) {
        name = include(cause.record) ? endpointOf(cause.record) : null;
        names.set(cause.record, name);
      }
      if (name === null) continue;
      let a = acc.get(name);
      if (!a) acc.set(name, (a = { all: bucket(), parent: bucket(), same: bucket() }));
      add(a.all, ms);
      if (cause.via === 'parent') add(a.parent, ms);
      if (cause.record.sameResponseAs) add(a.same, ms);
    }
    yield* rest(ENTRY_WORK + seen);
  }
  return new Map(Array.from(acc, ([name, a]) => [name, { ...cost(a.all), viaParent: cost(a.parent), fromSameResponse: cost(a.same) }]));
}
