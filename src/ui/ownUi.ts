/** rdx 자신이 그린 요소에 붙이는 표식. 요소 선택·박스 계산에서 뺀다. */
export const ROOT_ATTR = 'data-rdx-root';

export const ownUiProps = { [ROOT_ATTR]: '' };

export const isOwnUi = (el: Element | null): boolean => !!el?.closest(`[${ROOT_ATTR}]`);
