import { createContext, useCallback, useContext } from 'react';

import { pick, type Lang } from '../shared/lang.js';
import { useStoredState } from './hooks/useStoredState.js';

const LANG_KEY = 'react-data-xray:lang';

const LangContext = createContext<Lang>('en');

export const LangProvider = LangContext.Provider;

export const useLang = (): Lang => useContext(LangContext);

/** 그 자리에서 두 언어 문구를 고른다: `const t = useT(); t('Clear records', '기록 지우기')` */
export const useT = () => {
  const lang = useLang();
  return useCallback((en: string, ko: string) => pick(lang, en, ko), [lang]);
};

const parse = (raw: unknown): Lang | undefined => (raw === 'en' || raw === 'ko' ? raw : undefined);
// 고른 적이 없으면 브라우저 언어를 따른다.
const browserLang = (): Lang => (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en');

/** 패널 언어 설정. 고른 값을 localStorage 에 기억한다. */
export const useLangSetting = () => {
  const [lang, setLang] = useStoredState(LANG_KEY, parse, browserLang);
  return [lang, setLang] as const;
};
