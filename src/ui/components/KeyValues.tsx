import { codeBlockStyle, color } from '../theme.js';
import { Muted } from './Muted.js';

/** 헤더·쿼리 같은 이름-값 목록. 비어 있으면 (없음) */
export const KeyValues = ({ values }: { values?: Record<string, string> }) => {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return <Muted>(없음)</Muted>;
  return (
    <div style={codeBlockStyle}>
      {entries.map(([k, v]) => (
        <div key={k}>
          <span style={{ color: color.muted }}>{k}:</span> {v}
        </div>
      ))}
    </div>
  );
};
