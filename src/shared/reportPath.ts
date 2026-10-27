/** rdx 보고서를 주고받는 dev 서버 경로. 브라우저(보고서 업로드)와 dev 서버(미들웨어)가 같이 쓴다. */
export const REPORT_PATH = '/__rdx/report';
/** 미들웨어가 붙어 있다는 표시. 이 헤더가 없으면 프록시·SPA 폴백이 답한 것이라 보고서를 보내지 않는다. */
export const REPORT_HEADER = 'x-rdx-report';
