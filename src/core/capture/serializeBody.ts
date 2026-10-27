const describeFormValue = (value: FormDataEntryValue): string =>
  typeof value === 'string' ? value : `[file ${value.name} ${value.size}B]`;

/**
 * 요청 본문을 비교용 문자열로 바꾼다.
 * - 없으면 undefined
 * - 읽을 수 없는 본문(Blob, ArrayBuffer, 스트림 등)은 null. 같은 요청인지 알 수 없어 중복 판정에서 뺀다.
 */
export const serializeBody = (body: unknown): string | null | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return Array.from(body.entries())
      .map(([key, value]) => `${key}=${describeFormValue(value)}`)
      .join('&');
  }
  return null;
};
