import { PipeTransform, Injectable } from '@nestjs/common';

@Injectable()
export class ParseIntOrDefault implements PipeTransform {
  constructor(private readonly defaultValue: number) {}

  transform(value: string): number {
    if (value === '' || value === undefined) {
      return this.defaultValue;
    }
    const parsed = parseInt(value);
    return isNaN(parsed) ? this.defaultValue : parsed;
  }
}
