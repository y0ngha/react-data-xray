import { useState } from 'react';

import { isLibraryFrame } from '../../core/capture/libraryFrame.js';
import { STRICT_MODE_REPLAY } from '../../core/capture/requestContext.js';
import { CodeBlock } from '../components/CodeBlock.js';
import { Section } from '../components/Section.js';

const frameName = (line: string): string => /at\s+(?:async\s+)?([^\s(]+)/.exec(line)?.[1] ?? line.trim();

// 앱 프레임만 보이고 라이브러리 프레임은 한 줄로 접는다. 복사는 접힌 프레임까지 전체다.
export const StackSection = ({ stack }: { stack: string }) => {
  const [open, setOpen] = useState(false);
  const lines = stack.split('\n');
  const library = lines.filter(isLibraryFrame);
  const app = lines.filter((line) => !isLibraryFrame(line));
  // 앱 프레임이 하나도 없으면 접으면 빈 상자만 남으므로 접지 않는다.
  const foldable = library.length > 0 && app.length > 0;
  const shown = open || !foldable ? stack : app.join('\n');
  const key = library.find((line) => STRICT_MODE_REPLAY.test(line));
  const label = key ? `${frameName(key)} 외 ${library.length - 1}개` : `라이브러리 프레임 ${library.length}개`;
  return (
    <Section title="요청을 보낸 코드" copy={stack}>
      <CodeBlock text={shown} />
      {foldable && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '라이브러리 프레임 접기' : `${label} 펼치기`}
        </button>
      )}
    </Section>
  );
};
