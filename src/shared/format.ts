import { groupBy } from './collections.js';

/** 화면에 보여 주기 위한 순수 변환 함수들 */

export const truncate = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 값을 한 줄 JSON 으로. 직렬화할 수 없으면 문자열로 바꾼다. */
export const formatJson = (value: unknown, max = 120): string => {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : truncate(text, max);
  } catch {
    return String(value);
  }
};

/** JSON 이면 들여쓰기해서, 아니면 원문 그대로 */
export const prettyText = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/** `$.data.list[3].title` 같은 경로로 값을 꺼낸다. */
export const valueAt = (body: unknown, path: string): unknown => {
  const keys = path.replace(/^\$/, '').match(/[^.[\]]+/g) ?? [];
  return keys.reduce<unknown>((acc, k) => (acc as Record<string, unknown> | null | undefined)?.[k], body);
};

/** 현재 페이지 기준으로 URL 을 해석한다. 잘못된 URL 이면 null */
export const parseUrl = (url: string): URL | null => {
  try {
    return new URL(url, location.href);
  } catch {
    return null;
  }
};

/** `?a=1&b=2` 부분. 없으면 빈 문자열 */
export const queryOf = (url: string): string => parseUrl(url)?.search ?? '';

/** 쿼리 파라미터를 객체로. 같은 이름이 여러 번 오면 쉼표로 잇는다. */
export const queryParamsOf = (url: string): Record<string, string> | undefined => {
  const parsed = parseUrl(url);
  if (!parsed) return undefined;
  return Object.fromEntries(
    Array.from(
      groupBy(parsed.searchParams, ([k]) => k),
      ([k, pairs]) => [k, pairs.map(([, v]) => v).join(', ')],
    ),
  );
};

/** 24시간 HH:MM:SS. 브라우저 언어(오전·PM)를 따르지 않아 패널 문구와 언어가 섞이지 않는다. */
export const formatTime = (time: number): string => new Date(time).toTimeString().slice(0, 8);

export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** 퍼센트 인코딩을 푼다. 잘못 인코딩된 값(100%, %zz)이면 원문 그대로 둔다. */
export const safeDecode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
