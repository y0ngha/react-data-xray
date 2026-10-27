import { useEffect, useRef } from 'react';

export interface Hotkey {
  key: string;
  shift?: boolean;
  alt?: boolean;
}

/** Ctrl(macOS 는 Cmd 도) + key 조합 */
export const matchesHotkey = (e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'key'>, hotkey: Hotkey): boolean =>
  (e.ctrlKey || e.metaKey) &&
  e.key.toLowerCase() === hotkey.key.toLowerCase() &&
  !!hotkey.shift === e.shiftKey &&
  !!hotkey.alt === e.altKey;

/** 단축키와 Esc 를 듣는다. */
export const useHotkey = (hotkey: Hotkey, onHotkey: () => void, onEscape: () => void): void => {
  const handlers = useRef({ onHotkey, onEscape });
  useEffect(() => {
    handlers.current = { onHotkey, onEscape };
  }, [onHotkey, onEscape]);
  const { key, shift, alt } = hotkey;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return handlers.current.onEscape();
      if (!matchesHotkey(e, { key, shift, alt })) return undefined;
      e.preventDefault();
      return handlers.current.onHotkey();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, shift, alt]);
};
