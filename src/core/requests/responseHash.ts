// 같은 응답 판정에 쓰는 응답 지문. 응답 원문을 키마다 들고 있지 않으려고(#65) 길이와 64비트 해시만 남긴다.
// 앞부분만 잘라 비교하면 앞이 같고 뒤가 다른 응답을 같은 응답으로 보므로, 원문 전체를 해시한다.
// 해시는 cyrb53 식으로 만든다. 시드와 곱하는 수가 다른 32비트 갈래 두 개를 글자마다 따로 돌리고, 마지막 섞기에서만 서로 섞는다.
// 암호용 해시가 아니고, 이상적인 64비트 해시만큼 고르다는 보장도 없다. 그래도 같은 요청 키의 직전 응답 하나와만 비교하고 길이도 같아야 하므로,
// 일부러 만든 입력이 아니면 다른 응답이 우연히 같은 응답으로 보일 일은 사실상 없다.

export type ResponseDigest = { readonly length: number; readonly hi: number; readonly lo: number };

/** 한 조각에 해시하는 글자 수. 1MB 응답도 유휴 큐의 한 조각(4ms) 안에 들도록 나눈다. 이보다 짧은 응답은 한 번에 끝난다. */
export const HASH_CHUNK = 1 << 14;

/** 유휴 큐 step 처럼 조금씩 해시한다. step() 이 true 를 돌려준 뒤에만 digest() 를 부를 수 있다. */
export const createResponseHasher = (text: string): { step(): boolean; digest(): ResponseDigest } => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let i = 0;
  return {
    step() {
      const end = Math.min(text.length, i + HASH_CHUNK);
      for (; i < end; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
      }
      return i >= text.length;
    },
    digest() {
      // 덜 해시한 지문에 전체 길이를 붙이면 앞부분만 비교한 셈이 된다.
      if (i < text.length) throw new Error('rdx: response hash is not finished');
      let a = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
      a ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      let b = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
      b ^= Math.imul(a ^ (a >>> 13), 3266489909);
      return { length: text.length, hi: a >>> 0, lo: b >>> 0 };
    },
  };
};

/** 한 번에 해시한다. HASH_CHUNK 이하의 짧은 응답에 쓴다. */
export const digestOf = (text: string): ResponseDigest => {
  const hasher = createResponseHasher(text);
  while (!hasher.step());
  return hasher.digest();
};

export const sameDigest = (x: ResponseDigest, y: ResponseDigest): boolean => x.length === y.length && x.hi === y.hi && x.lo === y.lo;
