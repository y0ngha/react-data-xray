// SSE, ndjson 처럼 오래 열려 있는 스트림을 끝까지 버퍼링하지 않도록 뺀다.
const isStreaming = (contentType: string): boolean => /event-stream|ndjson|jsonl|stream/.test(contentType);

/** 같은 응답 재요청 비교 대상(JSON 응답) */
export const isJson = (contentType: string | null): boolean => !!contentType && contentType.includes('json') && !isStreaming(contentType);

/** 상세 화면에 원문을 보관할 텍스트 응답 */
export const isReadableText = (contentType: string | null): boolean =>
  !!contentType && !isStreaming(contentType) && /json|text|xml|javascript|x-www-form-urlencoded/.test(contentType);
