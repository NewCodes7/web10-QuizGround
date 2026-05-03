import { Controller, Get } from '@nestjs/common';
import { GameGateway } from './game.gateway';

@Controller('/api/status')
export class StatusController {
  constructor(private readonly gameGateway: GameGateway) {}

  @Get()
  getStatus() {
    return { players: this.gameGateway.getConnectionCount() };
  }
}
