/** rdx 보고서를 주고받는 dev 서버 경로. 브라우저(보고서 업로드)와 dev 서버(미들웨어)가 같이 쓴다. */
export const REPORT_PATH = '/__rdx/report';
/** 미들웨어가 붙어 있다는 표시. 이 헤더가 없으면 프록시·SPA 폴백이 답한 것이라 보고서를 보내지 않는다. */
export const REPORT_HEADER = 'x-rdx-report';
/** 자동 보고서 파일 이름(.rdx/report.json) */
export const DEFAULT_REPORT_NAME = 'report';

/**
 * snapshot 보고서 이름으로 쓸 수 있는지. 파일 이름이 되므로 경로를 만들 수 있는 글자와 . 으로 시작하는 이름은 받지 않고,
 * 5초마다 덮어쓰는 자동 보고서 이름도 받지 않는다
 * (대소문자를 가리지 않는 파일 시스템에서는 Report.json 도 같은 파일이다).
 */
export const isReportName = (name: string): boolean => /^[\w-][\w.-]{0,63}$/.test(name) && name.toLowerCase() !== DEFAULT_REPORT_NAME;
