import { registerBody } from '../requests/store.js';
import { attempt } from './attempt.js';
import { takePendingText } from './pendingTexts.js';

/** axios 처럼 응답 원문을 직접 JSON.parse 하는 경우, 파싱 결과를 그 응답의 본문으로 등록한다. */
export const interceptJsonParse = (): void => {
  const originalParse = JSON.parse;
  JSON.parse = function (text: string, reviver?: Parameters<typeof JSON.parse>[1]) {
    const result = originalParse.call(JSON, text, reviver);
    attempt(() => {
      const record = takePendingText(text);
      if (record) registerBody(record, result);
    });
    return result;
  };
};
