/** fetch 의 HeadersInit 을 소문자 키 객체로. 비어 있거나 잘못된 값이면 undefined */
export const headersToObject = (headers: HeadersInit | undefined): Record<string, string> | undefined => {
  if (!headers) return undefined;
  try {
    const entries = Array.from(new Headers(headers).entries());
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  } catch {
    return undefined;
  }
};

/** XHR 의 getAllResponseHeaders() 원문("name: value" 줄들)을 소문자 키 객체로 */
export const parseRawHeaders = (raw: string): Record<string, string> =>
  Object.fromEntries(
    raw
      .trim()
      .split(/[\r\n]+/)
      .map((line) => [line.indexOf(':'), line] as const)
      .filter(([colon]) => colon > 0)
      .map(([colon, line]) => [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]),
  );
