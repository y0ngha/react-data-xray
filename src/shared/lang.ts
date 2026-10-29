/** 화면 문구 언어. 보고서와 콘솔은 늘 영어다(AI 가 읽는 계약). */
export type Lang = 'en' | 'ko';

/** 지금 언어의 문구를 고른다. core 의 문구 함수가 lang 인자로 쓴다. */
export const pick = (lang: Lang, en: string, ko: string): string => (lang === 'ko' ? ko : en);
