/**
 * 레이아웃 뷰포트 크기(스크롤바 제외).
 * jsdom/SSR 에서는 clientWidth/clientHeight 가 0 이므로 innerWidth/innerHeight 로 대체한다.
 */
export const clientViewport = (): { width: number; height: number } => {
  const { clientWidth, clientHeight } = document.documentElement;
  return {
    width: clientWidth || window.innerWidth,
    height: clientHeight || window.innerHeight,
  };
};
