let nativeFetch: typeof fetch | undefined;

/** 가로채기 전의 fetch 를 보관한다(설치할 때 한 번). */
export const keepNativeFetch = (original: typeof fetch): void => {
  nativeFetch = original;
};

/** 가로채기 전의 fetch. rdx 가 스스로 보내는 요청(보고서, 소스맵)이 기록에 섞이지 않게 쓴다. 없으면 undefined */
export const getNativeFetch = (): typeof fetch | undefined => nativeFetch;
