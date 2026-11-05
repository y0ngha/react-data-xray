// 한 step 에서 세는 글자 수. 1MB 원문도 한 번에 세지 않고 큐의 4ms 조각에 나눠 넣는다.
export const CHARS_PER_STEP = 100_000;

let encoder: TextEncoder | undefined;
let buffer: Uint8Array | undefined;

/**
 * 글자를 UTF-8 로 보냈을 때의 바이트 수를 조각으로 센다. 원문 전체를 한 번에 encode 하면 큰 사본을 만들고 메인 스레드를 막으므로,
 * 조각마다 같은 버퍼에 encodeInto 한다(네이티브라 1MB 도 조각 몇 개).
 */
export const createByteCounter = (text: string): { step: () => boolean; total: () => number } => {
  let index = 0;
  let bytes = 0;
  return {
    step: () => {
      if (!encoder || !buffer) {
        encoder = new TextEncoder();
        buffer = new Uint8Array(CHARS_PER_STEP * 3);
      }
      let end = Math.min(index + CHARS_PER_STEP, text.length);
      // 서로게이트 쌍을 조각 경계에서 가르면 두 반쪽이 각각 대체 문자(3바이트)로 세진다. 쌍은 다음 조각으로 넘긴다.
      const last = text.charCodeAt(end - 1);
      if (end < text.length && end - 1 > index && last >= 0xd800 && last <= 0xdbff) end--;
      bytes += encoder.encodeInto(text.slice(index, end), buffer).written;
      index = end;
      return index >= text.length;
    },
    total: () => bytes,
  };
};
