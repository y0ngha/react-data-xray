import type { RenderReason } from '../../../core/render/types.js';

export const REASON_LABEL: Record<RenderReason, string> = {
  mount: 'mount',
  state: 'state',
  context: 'context',
  props: 'props',
  'same-content': 'same content, new reference',
  'new-callback': 'new callback',
  parent: 'parent render',
};
