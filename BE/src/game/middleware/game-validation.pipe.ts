import { GameWsException } from '../../common/exceptions/game.ws.exception';
import { ValidationPipe } from '@nestjs/common';

export class GameValidationPipe extends ValidationPipe {
  constructor(eventName: string) {
    super({
      transform: true,
      exceptionFactory: (errors) => {
        return new GameWsException(
          eventName,
          Object.values(errors[0].constraints)[0]
        );
      }
    });
  }
}