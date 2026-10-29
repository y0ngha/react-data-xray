import type { MouseEvent } from 'react';

import { Button } from './Button.js';

const copyText = (text: string) => {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    // 클립보드를 못 쓰는 환경이면 넘어간다.
  }
};

/** summary 안에 두어도 펼침/접힘이 같이 바뀌지 않도록 기본 동작을 막는다. */
export const CopyButton = ({ text }: { text: string }) => (
  <span onClickCapture={(e: MouseEvent) => e.preventDefault()} style={{ marginLeft: 8 }}>
    <Button subtle onClick={() => copyText(text)} title="Copy to clipboard">
      Copy
    </Button>
  </span>
);
