import { Test, TestingModule } from '@nestjs/testing';
import { TimeController } from './time.controller';

describe('TimeController', () => {
  let controller: TimeController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TimeController]
    }).compile();

    controller = module.get<TimeController>(TimeController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('서버 시각 반환 성공 테스트', async () => {
    const result = await controller.getTime();
    expect(result).toHaveProperty('serverTime');
  });
});
