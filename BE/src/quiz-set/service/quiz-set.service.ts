import { Injectable } from '@nestjs/common';
import { CreateQuizSetDto } from '../dto/create-quiz.dto';
import { UpdateQuizSetDto } from '../dto/update-quiz.dto';
import { QuizSetListResponseDto } from '../dto/quiz-set-list-response.dto';
import { QuizSetCreateService } from './quiz-set-create.service';
import { QuizSetReadService } from './quiz-set-read.service';
import { QuizSetUpdateService } from './quiz-set-update.service';
import { QuizSetDeleteService } from './quiz-set-delete.service';
import { UserModel } from '../../user/entities/user.entity';

@Injectable()
export class QuizSetService {
  constructor(
    private readonly quizSetCreateService: QuizSetCreateService,
    private readonly quizSetReadService: QuizSetReadService,
    private readonly quizSetUpdateService: QuizSetUpdateService,
    private readonly quizSetDeleteService: QuizSetDeleteService
  ) {}

  /**
   * 퀴즈셋, 퀴즈, 선택지를 생성합니다.
   * @param createQuizSetDto 생성할 퀴즈셋 데이터
   * @param user 생성하는 유저
   * @returns 생성된 퀴즈셋
   */
  async createQuizSet(dto: CreateQuizSetDto, user: UserModel) {
    return this.quizSetCreateService.createQuizSet(dto, user);
  }

  /**
   * 퀴즈셋 목록을 조회합니다.
   * @param category 카테고리
   * @param cursor 오프셋
   * @param take 한 페이지 당 개수
   * @returns 퀴즈셋 목록
   */
  async findAllWithQuizzesAndChoices(
    category: string,
    cursor: number,
    take: number,
    search: string
  ): Promise<QuizSetListResponseDto> {
    return this.quizSetReadService.findAllWithQuizzesAndChoices(category, cursor, take, search);
  }

  /**
   * 현재 api 명세에 따라 user 정보는 안주는것으로 구현되어있음.
   * 이에따라 test code에서도 user 정보를 test 하지 않음.
   * 향후 필요시 구현가능(relation 옵션 활용)
   * @param id
   */
  async findOne(id: number) {
    return this.quizSetReadService.findOne(id);
  }

  /**
   * 주어진 ID의 퀴즈셋을 소프트 삭제합니다.
   * @param id 삭제할 퀴즈셋의 ID
   * @returns 삭제 결과를 포함한 응답 객체
   */
  async remove(id: number, user: UserModel) {
    return this.quizSetDeleteService.remove(id, user);
  }

  // REFACTOR: QuizSetUpdateService 메서드 분리 필요 및 최적화
  async update(id: number, updateDto: UpdateQuizSetDto, user: UserModel) {
    return this.quizSetUpdateService.update(id, updateDto, user);
  }
}
