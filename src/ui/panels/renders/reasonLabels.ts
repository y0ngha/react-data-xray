import type { RenderReason } from '../../../core/render/types.js';

export const REASON_LABEL: Record<RenderReason, string> = {
  mount: 'mount',
  state: 'state',
  context: 'context',
  props: 'props',
  'same-content': '같은 내용 새 참조',
  'new-callback': '새 콜백',
  parent: '부모 렌더',
};
