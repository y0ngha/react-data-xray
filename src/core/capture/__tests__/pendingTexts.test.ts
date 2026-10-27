import { expect, it } from 'vitest';

import { createRecord } from '../../requests/store.js';
import { rememberText, takePendingText } from '../pendingTexts.js';

it('JSON 처럼 보이는 원문만 기억한다(HTML·CSV 같은 큰 원문을 붙잡지 않는다)', () => {
  const record = createRecord('xhr', 'GET', '/api/x');
  rememberText('<html>big</html>', record);
  rememberText('  {"a":1}', record);
  expect(takePendingText('<html>big</html>')).toBeUndefined();
  expect(takePendingText('  {"a":1}')).toBe(record);
});
