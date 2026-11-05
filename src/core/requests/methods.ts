/** 서버 상태를 바꾸는 요청 메서드. 응답은 결과 확인용이고, 뒤따른 조회는 그 변경 때문일 수 있다. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const isMutating = (method: string): boolean => MUTATING_METHODS.has(method.toUpperCase());
