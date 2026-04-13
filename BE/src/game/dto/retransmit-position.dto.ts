import { IsNumber, IsString, Length, Min } from 'class-validator';

export class RetransmitPositionDto {
  @IsString()
  @Length(6, 6, { message: 'PIN번호는 6자리이어야 합니다.' })
  gameId: string;

  @IsNumber()
  @Min(0, { message: 'lastSeq는 0 이상이어야 합니다.' })
  lastSeq: number;
}
