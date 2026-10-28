// 무거운 분석을 한 번에 몰아 돌리지 않고, 놀고 있는 틱에 조금씩 나눠 돌리는 공용 큐.
const SLICE_MS = 4;
// 한 번도 쉬지 않는 페이지에서도 일이 쌓이지 않게, 일이 남아 있으면 이 간격마다 한 조각은 돈다.
const MAX_WAIT_MS = 50;

type Step = () => boolean;
type Idle = { timeRemaining(): number; didTimeout: boolean };

const queue: Step[] = [];
let running = false;
let scheduled = false;

/** step 은 작은 일 하나를 하고, 끝났으면 true 를 돌려준다. false 면 다음 틱에 다시 불린다. */
// 끝나지 않는 step 이 큐를 영원히 붙잡지 않게, 이만큼 불리면 버린다.
const MAX_CALLS_PER_STEP = 100_000;

export function enqueue(step: Step): void {
  let calls = 0;
  queue.push(() => ++calls > MAX_CALLS_PER_STEP || step());
  schedule();
}

export const isQueuePending = (): boolean => queue.length > 0;

/** 지금 바로 돌린다. 다 비었으면 true. step 안에서 다시 부르면 아무것도 안 하고 false. */
export function flushQueue(limitMs = Infinity): boolean {
  if (running) return false;
  running = true;
  const start = performance.now();
  try {
    while (queue.length > 0) {
      let done: boolean;
      try {
        done = queue[0]();
      } catch {
        done = true; // 던지는 step 은 버린다
      }
      if (done) queue.shift();
      if (performance.now() - start >= limitMs) break;
    }
  } finally {
    running = false;
  }
  return queue.length === 0;
}

function schedule(): void {
  if (scheduled || queue.length === 0) return;
  scheduled = true;
  const g = globalThis as {
    requestIdleCallback?: (cb: (d: Idle) => void, o: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleId: number | undefined;
  const tick = (idle?: Idle): void => {
    if (fired) return;
    fired = true;
    clearTimeout(timer);
    if (idleId !== undefined) g.cancelIdleCallback?.call(globalThis, idleId);
    scheduled = false;
    const slice = !idle || idle.didTimeout ? SLICE_MS : Math.min(SLICE_MS, idle.timeRemaining());
    flushQueue(slice);
    schedule();
  };
  if (g.requestIdleCallback) {
    idleId = g.requestIdleCallback.call(globalThis, tick, { timeout: MAX_WAIT_MS });
    timer = setTimeout(() => tick(), MAX_WAIT_MS); // rIC 가 오래 안 불리는 바쁜 페이지의 보험
    // requestIdleCallback 이 없으면(Safari) 한가한지 알 수 없으므로, 바쁜 페이지와 같은 간격으로만 한 조각씩 돈다.
  } else timer = setTimeout(() => tick(), MAX_WAIT_MS);
}
