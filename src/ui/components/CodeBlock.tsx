import { codeBlockStyle } from '../theme.js';

export const CodeBlock = ({ text }: { text: string }) => <pre style={codeBlockStyle}>{text}</pre>;
