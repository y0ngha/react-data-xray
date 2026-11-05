import { endpointOf } from '../requests/requestKey.js';
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

// 유휴 큐 한 step 이 4ms 를 넘기지 않게 이만큼 렌더 기록을 볼 때마다 쉰다.
const EVENT_CHUNK = 2000;
// 컴포넌트 하나를 거르는 일을 렌더 기록 몇 개 보는 것으로 칠지
const ENTRY_WORK = 10;
const round1 = (n: number): number => Math.round(n * 10) / 10;

interface Acc {
  count: number;
  ms: number;
  timed: number;
  parent: { count: number; ms: number };
  same: { count: number; ms: number };
}

const finish = (a: Acc): EndpointRenders => {
  const cost = (count: number, ms: number): RenderCost => (a.timed > 0 ? { count, ms: round1(ms) } : { count });
  return { ...cost(a.count, a.ms), viaParent: cost(a.parent.count, a.parent.ms), fromSameResponse: cost(a.same.count, a.same.ms) };
};

/**
 * since 뒤 렌더 기록 중 원인 요청(cause.record)이 있는 것을 그 요청의 엔드포인트(endpointOf)별로 모은다.
 * 기록은 이미 유휴 큐에서 만든 것이라 여기서는 세기만 하고, 조각마다 yield 한다(주기 화면은 큐에서, 보고서는 그 자리에서 돌린다).
 */
export function* countEndpointRendersSteps(
  entries: readonly RenderEntry[],
  since: number,
  keep: (entry: RenderEntry) => boolean = () => true,
): Generator<void, Map<string, EndpointRenders>> {
  const acc = new Map<string, Acc>();
  // 한 응답이 여러 컴포넌트를 렌더하므로 엔드포인트 이름(GraphQL 본문을 읽을 수 있다)은 요청마다 한 번만 만든다.
  const names = new Map<RequestRecord, string>();
  let work = 0;
  for (const entry of entries) {
    const { events } = entry;
    // 구간 안 렌더가 없는 것은 거르기(분석 대상 안인지, 조상을 따라 올라간다) 전에 뺀다.
    if ((events[events.length - 1]?.time ?? -Infinity) < since) continue;
    work += ENTRY_WORK; // 거르기도 일이다
    if (!keep(entry)) continue;
    // 기록은 시간순이라 끝에서부터 구간 밖이 나올 때까지만 본다.
    for (let i = events.length - 1; i >= 0 && events[i].time >= since; i--) {
      const { cause, ms } = events[i];
      if (++work >= EVENT_CHUNK) {
        work = 0;
        yield;
      }
      if (!cause) continue;
      let name = names.get(cause.record);
      if (name === undefined) {
        name = endpointOf(cause.record);
        names.set(cause.record, name);
      }
      const a = acc.get(name) ?? { count: 0, ms: 0, timed: 0, parent: { count: 0, ms: 0 }, same: { count: 0, ms: 0 } };
      const t = ms ?? 0;
      a.count++;
      a.ms += t;
      if (ms !== undefined) a.timed++;
      if (cause.via === 'parent') {
        a.parent.count++;
        a.parent.ms += t;
      }
      if (cause.record.sameResponseAs) {
        a.same.count++;
        a.same.ms += t;
      }
      acc.set(name, a);
    }
  }
  return new Map(Array.from(acc, ([name, a]) => [name, finish(a)]));
}
