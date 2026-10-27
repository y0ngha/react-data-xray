import { FixedRect } from '../components/FixedRect.js';
import { color, Z_HIGHLIGHT } from '../theme.js';

/** 요소 선택 중 호버한 요소 */
export const PickHighlight = ({ rect }: { rect: DOMRect }) => (
  <FixedRect rect={rect} style={{ outline: `2px solid ${color.accent}`, background: 'rgba(59,130,246,.15)', zIndex: Z_HIGHLIGHT }} />
);
