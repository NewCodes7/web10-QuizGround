export class GameWsException extends Error {
  constructor(
    // 참고: public readonly -> 자동으로 해당 매개변수를 클래스의 속성으로 선언하고 초기화
    public readonly eventName: string,
    public readonly message: string
  ) {
    super(message);
  }
}
