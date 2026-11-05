import { ROOT_ATTR } from '../shared/ownUi.js';

// 판정은 core 도 쓴다(쓰지 않는 응답 판정이 패널을 소비자로 세지 않게). 표식과 판정은 shared 에 둔다.
export { isOwnUi } from '../shared/ownUi.js';

export const ownUiProps = { [ROOT_ATTR]: '' };
