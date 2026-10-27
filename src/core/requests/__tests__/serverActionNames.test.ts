import { describe, expect, it, vi } from 'vitest';

import { keepNativeFetch } from '../../capture/nativeFetch.js';
import { endpointOf } from '../requestKey.js';
import { actionNameOf, learnActionNames, onActionNames, parseActionNames } from '../serverActionNames.js';

// 실제 dev 번들에서 옮겨 온 모양(모듈 참조 이름은 줄였다)
const TURBOPACK = `var a = (0, __TURBOPACK__imported__module__$5b$project$5d$__["createServerReference"])("4033fcd3d6fa1ceb88834a66cdfb28848d8b65c163", __TURBOPACK__imported__module__$5b$project$5d$__["callServer"], void 0, __TURBOPACK__imported__module__$5b$project$5d$__["findSourceMapURL"], "getNewsCardsAction");`;
const WEBPACK = `const b = (0,private_next_rsc_action_client_wrapper__WEBPACK_IMPORTED_MODULE_0__.createServerReference)("601f13b65c219414935f85f3c77c720906a6e8df9e", private_next_rsc_action_client_wrapper__WEBPACK_IMPORTED_MODULE_0__.callServer, void 0, private_next_rsc_action_client_wrapper__WEBPACK_IMPORTED_MODULE_0__.findSourceMapURL, "ensureNewsAnalyzedAction");`;

describe('Server Action 이름', () => {
  it('Turbopack·webpack 번들의 createServerReference 에서 id 와 함수 이름 짝을 찾는다', () => {
    expect(parseActionNames(`${TURBOPACK}\n${WEBPACK}`)).toEqual([
      ['4033fcd3d6fa1ceb88834a66cdfb28848d8b65c163', 'getNewsCardsAction'],
      ['601f13b65c219414935f85f3c77c720906a6e8df9e', 'ensureNewsAnalyzedAction'],
    ]);
    expect(parseActionNames('createServerReference("not-hex", x, "name")')).toEqual([]);
  });

  it('받아 둔 스크립트를 한 번씩만 읽어 이름을 배우고, 엔드포인트 이름을 이름으로 바꾼다', async () => {
    const id = '4033fcd3d6fa1ceb88834a66cdfb28848d8b65c163';
    const record = { method: 'POST', url: '/MSFT/news', action: id };
    expect(endpointOf(record)).toBe('POST /MSFT/news (action 4033fcd3)');

    const script = document.createElement('script');
    script.src = `${location.origin}/_next/static/chunks/page.js`;
    document.head.append(script);
    const original = vi.fn<typeof fetch>(async () => new Response(TURBOPACK));
    keepNativeFetch(original);
    const notified = vi.fn<() => void>();
    const off = onActionNames(notified);

    await learnActionNames();
    await learnActionNames(); // 이미 읽은 스크립트는 다시 받지 않는다.

    expect(original).toHaveBeenCalledTimes(1);
    expect(actionNameOf(id)).toBe('getNewsCardsAction');
    expect(notified).toHaveBeenCalledTimes(1);
    expect(endpointOf(record)).toBe('POST /MSFT/news (getNewsCardsAction)');
    off();
    script.remove();
  });
});
