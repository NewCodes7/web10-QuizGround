import { Injectable } from '@nestjs/common';
import * as v8 from 'node:v8';
import * as fs from 'node:fs';
import * as os from 'node:os';

export interface SnapshotInfo {
  id: string;
  label: string;
  filePath: string;
  takenAt: number;
  sizeBytes: number;
}

@Injectable()
export class HeapSnapshotService {
  private readonly snapshots = new Map<string, SnapshotInfo>();

  takeSnapshot(label = 'manual'): SnapshotInfo {
    const filePath = v8.writeHeapSnapshot(os.tmpdir());
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const sizeBytes = fs.statSync(filePath).size;
    const info: SnapshotInfo = { id, label, filePath, takenAt: Date.now(), sizeBytes };
    this.snapshots.set(id, info);
    return info;
  }

  list(): SnapshotInfo[] {
    return [...this.snapshots.values()].sort((a, b) => a.takenAt - b.takenAt);
  }

  getFilePath(id: string): string | null {
    return this.snapshots.get(id)?.filePath ?? null;
  }

  delete(id: string): boolean {
    const info = this.snapshots.get(id);
    if (!info) return false;
    this.snapshots.delete(id);
    fs.unlink(info.filePath, () => {});
    return true;
  }
}
