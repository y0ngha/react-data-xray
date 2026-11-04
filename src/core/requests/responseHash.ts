// 같은 응답 판정에 쓰는 응답 지문. 응답 원문을 키마다 들고 있지 않으려고(#65) 길이와 64비트 해시만 남긴다.
// 같은 요청 키의 직전 응답 하나와만 비교하므로, 독립된 32비트 해시 두 개(FNV-1a, murmur 식 곱셈)면 충돌은 무시할 만하다.
// 앞부분만 잘라 비교하면 앞이 같고 뒤가 다른 응답을 같은 응답으로 보므로, 원문 전체를 해시한다.

export type ResponseDigest = { readonly length: number; readonly hi: number; readonly lo: number };

// 1MB 응답도 유휴 큐의 한 조각(4ms)을 넘기지 않게 나눠 해시한다.
const CHUNK = 1 << 14;

const fmix = (h: number): number => {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

/** 유휴 큐 step 처럼 조금씩 해시한다. step() 이 true 를 돌려준 뒤 digest() 가 지문이다. */
export const createResponseHasher = (text: string): { step(): boolean; digest(): ResponseDigest } => {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  let i = 0;
  return {
    step() {
      const end = Math.min(text.length, i + CHUNK);
      for (; i < end; i++) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193);
        b = Math.imul(b ^ c, 0x5bd1e995);
        b ^= b >>> 15;
      }
      return i >= text.length;
    },
    digest() {
      // 두 갈래를 서로 섞어 한쪽만 같은 경우에도 결과 전체가 달라지게 한다.
      return { length: text.length, hi: fmix(a ^ Math.imul(b, 0x27d4eb2d)), lo: fmix(b ^ Math.imul(a, 0x165667b1)) };
    },
  };
};

/** 한 번에 해시한다(테스트와 짧은 응답용). */
export const digestOf = (text: string): ResponseDigest => {
  const hasher = createResponseHasher(text);
  while (!hasher.step());
  return hasher.digest();
};

export const sameDigest = (x: ResponseDigest, y: ResponseDigest): boolean => x.length === y.length && x.hi === y.hi && x.lo === y.lo;
