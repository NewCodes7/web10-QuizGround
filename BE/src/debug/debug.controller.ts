import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Response } from 'express';
import { Session } from 'node:inspector/promises';
import type { Profiler } from 'node:inspector';
import * as v8 from 'node:v8';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Redis from 'ioredis';
import { HeapSnapshotService } from './heap-snapshot.service';

interface JobMeta {
  status: 'running' | 'done' | 'error';
  startTime: number;
  seconds: number;
  error?: string;
}

const LOCK_KEY = 'Debug:ProfileLock';

@Controller('api/debug')
export class DebugController {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly heapSnapshotService: HeapSnapshotService
  ) {}

  /**
   * CPU 플레임그래프 UI — 브라우저에서 버튼으로 프로파일링 트리거
   * GET /api/debug/flamegraph?token=SECRET
   */
  @Get('flamegraph')
  flamegraphUi(@Query('token') token: string, @Res() res: Response) {
    this.validateToken(token);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildFlameUiHtml(token));
  }

  /**
   * 백그라운드 프로파일링 시작 — 즉시 jobId 반환
   * POST /api/debug/flamegraph/start?token=SECRET&seconds=30
   */
  @Post('flamegraph/start')
  async startProfile(@Query('token') token: string, @Query('seconds') seconds = '30') {
    this.validateToken(token);

    const secs = Math.min(Math.max(parseInt(seconds, 10) || 30, 5), 120);
    const locked = await this.redis.set(LOCK_KEY, '1', 'EX', secs + 60, 'NX');
    if (!locked) {
      throw new ConflictException('Profile already running');
    }

    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const meta: JobMeta = { status: 'running', startTime: Date.now(), seconds: secs };
    await this.redis.set(`Debug:Job:${jobId}`, JSON.stringify(meta), 'EX', secs + 60);

    this.collectProfile(secs)
      .then(async (profile) => {
        const raw = await this.redis.get(`Debug:Job:${jobId}`);
        const prev: JobMeta = raw ? JSON.parse(raw) : meta;
        await this.redis.set(
          `Debug:Job:${jobId}`,
          JSON.stringify({ ...prev, status: 'done' }),
          'EX',
          300
        );
        await this.redis.set(`Debug:Job:${jobId}:Data`, JSON.stringify(profile), 'EX', 300);
      })
      .catch(async (err: Error) => {
        const raw = await this.redis.get(`Debug:Job:${jobId}`);
        const prev: JobMeta = raw ? JSON.parse(raw) : meta;
        await this.redis.set(
          `Debug:Job:${jobId}`,
          JSON.stringify({ ...prev, status: 'error', error: err?.message ?? String(err) }),
          'EX',
          300
        );
      })
      .finally(async () => {
        await this.redis.del(LOCK_KEY);
      });

    return { jobId, seconds: secs };
  }

  /**
   * 프로파일링 상태 폴링 — 즉시 반환
   * GET /api/debug/flamegraph/status?token=SECRET&jobId=JOB_ID
   */
  @Get('flamegraph/status')
  async profileStatus(@Query('token') token: string, @Query('jobId') jobId: string) {
    this.validateToken(token);
    const raw = await this.redis.get(`Debug:Job:${jobId}`);
    if (!raw) {
      throw new NotFoundException('Job not found');
    }

    const job: JobMeta = JSON.parse(raw);
    const elapsed = Math.floor((Date.now() - job.startTime) / 1000);
    const remaining = Math.max(job.seconds - elapsed, 0);
    return { status: job.status, elapsed, remaining, total: job.seconds, error: job.error };
  }

  /**
   * 완료된 프로파일 데이터 반환 — 즉시 반환
   * GET /api/debug/flamegraph/data?token=SECRET&jobId=JOB_ID
   */
  @Get('flamegraph/data')
  async profileData(
    @Query('token') token: string,
    @Query('jobId') jobId: string,
    @Res() res: Response
  ) {
    this.validateToken(token);
    const raw = await this.redis.get(`Debug:Job:${jobId}`);
    if (!raw) {
      throw new NotFoundException('Job not found');
    }
    const job: JobMeta = JSON.parse(raw);
    if (job.status === 'running') {
      throw new BadRequestException('Profile still running');
    }
    if (job.status === 'error') {
      throw new BadRequestException(`Profile failed: ${job.error}`);
    }

    const data = await this.redis.get(`Debug:Job:${jobId}:Data`);
    if (!data) {
      throw new NotFoundException('Profile data not found');
    }
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  }

  /**
   * CPU 프로파일 직접 다운로드 (curl 용, 최대 60s)
   * GET /api/debug/profile?token=SECRET&seconds=30
   */
  @Get('profile')
  async cpuProfile(
    @Query('token') token: string,
    @Query('seconds') seconds = '30',
    @Res() res: Response
  ) {
    this.validateToken(token);
    const secs = Math.min(parseInt(seconds, 10) || 30, 60);
    const locked = await this.redis.set(LOCK_KEY, '1', 'EX', secs + 60, 'NX');
    if (!locked) {
      throw new ConflictException('Profile already running');
    }
    const profile = await this.collectProfile(secs).finally(async () => {
      await this.redis.del(LOCK_KEY);
    });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="cpu-${Date.now()}.cpuprofile"`);
    res.send(JSON.stringify(profile));
  }

  /**
   * 힙 스냅샷 단일 즉시 다운로드 (backward compat)
   * GET /api/debug/heap?token=SECRET
   */
  @Get('heap')
  heapSnapshot(@Query('token') token: string, @Res() res: Response) {
    this.validateToken(token);
    const filePath = v8.writeHeapSnapshot(
      path.join(os.tmpdir(), `heap-${process.pid}-${Date.now()}.heapsnapshot`)
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.sendFile(filePath, (err) => {
      fs.unlink(filePath, () => {});
      if (err && !res.headersSent) {
        res.status(500).end();
      }
    });
  }

  /**
   * 스냅샷 촬영 후 저장 (비교 분석용)
   * POST /api/debug/heap/take?token=SECRET&label=baseline
   */
  @Post('heap/take')
  heapTake(@Query('token') token: string, @Query('label') label = 'manual') {
    this.validateToken(token);
    const { id, takenAt, sizeBytes, filePath: _ } = this.heapSnapshotService.takeSnapshot(label);
    return { id, label, takenAt, sizeBytes };
  }

  /**
   * 저장된 스냅샷 목록
   * GET /api/debug/heap/list?token=SECRET
   */
  @Get('heap/list')
  heapList(@Query('token') token: string) {
    this.validateToken(token);
    return this.heapSnapshotService.list().map(({ id, label, takenAt, sizeBytes }) => ({
      id,
      label,
      takenAt,
      sizeBytes
    }));
  }

  /**
   * 저장된 스냅샷 다운로드
   * GET /api/debug/heap/download?token=SECRET&id=xxx
   */
  @Get('heap/download')
  heapDownload(@Query('token') token: string, @Query('id') id: string, @Res() res: Response) {
    this.validateToken(token);
    const filePath = this.heapSnapshotService.getFilePath(id);
    if (!filePath) throw new NotFoundException('Snapshot not found');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) res.status(500).end();
    });
  }

  /**
   * 저장된 스냅샷 삭제
   * DELETE /api/debug/heap/delete?token=SECRET&id=xxx
   */
  @Delete('heap/delete')
  heapDelete(@Query('token') token: string, @Query('id') id: string) {
    this.validateToken(token);
    const deleted = this.heapSnapshotService.delete(id);
    if (!deleted) throw new NotFoundException('Snapshot not found');
    return { deleted: true };
  }

  /**
   * 힙 스냅샷 관리 UI
   * GET /api/debug/heap/ui?token=SECRET
   */
  @Get('heap/ui')
  heapUi(@Query('token') token: string, @Res() res: Response) {
    this.validateToken(token);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildHeapUiHtml(token));
  }

  private async collectProfile(seconds: number): Promise<Profiler.Profile> {
    const session = new Session();
    session.connect();
    try {
      await session.post('Profiler.enable');
      await session.post('Profiler.setSamplingInterval', { interval: 10000 });
      await session.post('Profiler.start');
      await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
      const { profile } = await session.post('Profiler.stop');
      return profile;
    } finally {
      session.disconnect();
    }
  }

  private validateToken(token: string) {
    const expected = process.env.DEBUG_TOKEN;
    if (!expected) {
      throw new ServiceUnavailableException('DEBUG_TOKEN not configured');
    }
    if (token !== expected) {
      throw new UnauthorizedException();
    }
  }
}

// ─── Heap UI HTML ───────────────────────────────────────────────────────────

function buildHeapUiHtml(token: string): string {
  const safeToken = JSON.stringify(token);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Heap Snapshot Manager</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.6 'Segoe UI',system-ui,sans-serif;background:#0f0f13;color:#e0e0e0;padding:24px}
h1{font-size:22px;color:#fff;margin-bottom:4px}
.subtitle{color:#555;font-size:12px;margin-bottom:24px}
.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#1a1a2e;border-radius:10px;padding:16px 20px;margin-bottom:20px}
label{color:#aaa;font-size:13px}
input[type=text]{padding:7px 12px;border-radius:6px;background:#1e1e2e;border:1px solid #333;color:#e0e0e0;font-size:13px;width:220px}
input[type=text]:focus{outline:none;border-color:#4f46e5}
.btn{padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:500;transition:background .15s}
.btn-primary{background:#4f46e5;color:#fff}
.btn-primary:hover:not(:disabled){background:#4338ca}
.btn-primary:disabled{background:#2a2a3e;color:#555;cursor:not-allowed}
.btn-sm{padding:5px 12px;border-radius:6px;border:1px solid #333;background:#1e1e2e;color:#aaa;font-size:12px;cursor:pointer}
.btn-sm:hover{background:#252535;color:#ddd}
.btn-danger{border-color:#7f1d1d;color:#fca5a5}
.btn-danger:hover{background:#1f1015;color:#fca5a5}
#msg{font-size:13px;color:#4ade80;min-height:20px;margin-bottom:8px}
#msg.err{color:#fca5a5}
table{width:100%;border-collapse:collapse;font-size:13px;background:#111118;border-radius:10px;overflow:hidden}
th{text-align:left;padding:10px 14px;background:#1a1a2e;color:#888;font-weight:500}
td{padding:8px 14px;border-bottom:1px solid #1a1a2e}
tr:last-child td{border-bottom:none}
tr:hover td{background:#14141e}
.id{font-family:monospace;font-size:11px;color:#555}
.lbl{color:#93c5fd;font-weight:500}
.sz{color:#6b7280}
.ts{color:#6b7280;font-size:12px}
.actions{display:flex;gap:6px}
.hint{margin-top:24px;background:#131320;border:1px solid #1e1e30;border-radius:10px;padding:18px 20px;font-size:13px;color:#888;line-height:1.8}
.hint h3{color:#aaa;font-size:14px;margin-bottom:8px}
.hint code{background:#1a1a2e;padding:2px 6px;border-radius:4px;color:#93c5fd;font-family:monospace;font-size:12px}
.badge{display:inline-block;background:#1e1e2e;border:1px solid #2a2a3e;border-radius:4px;padding:1px 8px;font-size:11px;color:#888;margin-right:4px}
</style>
</head>
<body>
<h1>Heap Snapshot Manager</h1>
<p class="subtitle">V8 Heap Snapshot — Old gen retention 분석용 | QuizGround Debug</p>

<div class="controls">
  <label for="lbl-input">Label</label>
  <input type="text" id="lbl-input" value="baseline" placeholder="baseline / t7-before-spike">
  <button class="btn btn-primary" id="take-btn" onclick="takeSnapshot()">Take Snapshot</button>
</div>

<div id="msg"></div>

<table id="snap-table">
  <thead><tr><th>#</th><th>Label</th><th>Time (KST)</th><th>Size</th><th>ID</th><th>Actions</th></tr></thead>
  <tbody id="snap-tbody"><tr><td colspan="6" style="color:#444;text-align:center;padding:20px">Loading...</td></tr></tbody>
</table>

<div class="hint">
  <h3>Chrome DevTools Comparison 방법</h3>
  1. <code>baseline</code> 스냅샷 다운로드 → <code>t7-before-spike</code> 스냅샷 다운로드<br>
  2. Chrome → F12 → Memory 탭 → <strong>Load</strong> 버튼으로 #1 로드<br>
  3. 다시 <strong>Load</strong> 버튼으로 #2 로드<br>
  4. 상단 드롭다운에서 <strong>Comparison</strong> 선택<br>
  5. <strong>Retained Size</strong> 열 내림차순 정렬 → Old gen에 누적된 객체 타입 확인<br><br>
  <strong>SIGUSR2 트리거:</strong> <code>kill -USR2 $(pgrep -f "node dist/main")</code> → 서버 로그에 스냅샷 경로 출력, 이 UI에서 목록 확인
</div>

<script>
const TOKEN = ${safeToken};
let refreshTimer = null;

async function takeSnapshot() {
  const label = document.getElementById('lbl-input').value.trim() || 'manual';
  const btn = document.getElementById('take-btn');
  btn.disabled = true;
  setMsg('');
  try {
    const r = await fetch('/api/debug/heap/take?token=' + TOKEN + '&label=' + encodeURIComponent(label), { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || r.statusText);
    setMsg('Snapshot taken: ' + d.id + ' (' + fmt(d.sizeBytes) + ')');
    await loadList();
  } catch(e) { setMsg(e.message, true); }
  finally { btn.disabled = false; }
}

async function deleteSnapshot(id) {
  if (!confirm('Delete snapshot ' + id + '?')) return;
  try {
    const r = await fetch('/api/debug/heap/delete?token=' + TOKEN + '&id=' + id, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || r.statusText);
    await loadList();
  } catch(e) { setMsg(e.message, true); }
}

async function loadList() {
  try {
    const r = await fetch('/api/debug/heap/list?token=' + TOKEN);
    if (!r.ok) return;
    const list = await r.json();
    const tbody = document.getElementById('snap-tbody');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:#444;text-align:center;padding:20px">No snapshots yet</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(function(s, i) {
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td class="lbl">' + esc(s.label) + '</td>' +
        '<td class="ts">' + fmtTime(s.takenAt) + '</td>' +
        '<td class="sz">' + fmt(s.sizeBytes) + '</td>' +
        '<td class="id">' + esc(s.id) + '</td>' +
        '<td class="actions">' +
          '<a href="/api/debug/heap/download?token=' + TOKEN + '&id=' + s.id + '" class="btn-sm" download>Download</a>' +
          ' <button class="btn-sm btn-danger" onclick="deleteSnapshot(' + JSON.stringify(s.id) + ')">Delete</button>' +
        '</td>' +
        '</tr>';
    }).join('');
  } catch(_) {}
}

function fmt(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setMsg(msg, isErr) {
  var el = document.getElementById('msg');
  el.textContent = msg;
  el.className = isErr ? 'err' : '';
}

loadList();
refreshTimer = setInterval(loadList, 3000);
</script>
</body>
</html>`;
}

// ─── Flame UI HTML ──────────────────────────────────────────────────────────

function buildFlameUiHtml(token: string): string {
  const safeToken = JSON.stringify(token);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CPU Flamegraph</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/d3-flame-graph@4/dist/d3-flamegraph.css">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.6 'Segoe UI',system-ui,sans-serif;background:#0f0f13;color:#e0e0e0;padding:24px}
h1{font-size:22px;color:#fff;margin-bottom:4px}
.subtitle{color:#555;font-size:12px;margin-bottom:24px}
.controls{display:flex;align-items:center;gap:16px;flex-wrap:wrap;background:#1a1a2e;border-radius:10px;padding:16px 20px;margin-bottom:20px}
label{color:#aaa;font-size:13px}
input[type=range]{width:160px;accent-color:#4f46e5}
#seconds-val{font-weight:600;color:#fff;min-width:40px}
.btn{padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:500;transition:background .15s}
.btn-primary{background:#4f46e5;color:#fff}
.btn-primary:hover:not(:disabled){background:#4338ca}
.btn-primary:disabled{background:#2a2a3e;color:#555;cursor:not-allowed}
.btn-sm{padding:6px 14px;border-radius:6px;border:1px solid #333;background:#1e1e2e;color:#aaa;font-size:12px;cursor:pointer}
.btn-sm:hover{background:#252535;color:#ddd}
#status-box{display:none;background:#1a1a2e;border-radius:10px;padding:16px 20px;margin-bottom:20px}
.status-row{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.spinner{width:16px;height:16px;border:2px solid #2a2a3e;border-top-color:#4f46e5;border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
#status-text{color:#aaa;font-size:13px}
progress{width:100%;height:6px;border-radius:3px;appearance:none;background:#2a2a3e}
progress::-webkit-progress-bar{background:#2a2a3e;border-radius:3px}
progress::-webkit-progress-value{background:linear-gradient(90deg,#4f46e5,#7c3aed);border-radius:3px}
#error-box{display:none;background:#1f1015;border:1px solid #7f1d1d;border-radius:10px;padding:14px 18px;color:#fca5a5;margin-bottom:20px;font-size:13px}
#results{display:none}
.results-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px}
.results-meta{color:#666;font-size:12px}
.btn-group{display:flex;gap:8px;align-items:center}
.tabs{display:flex;gap:8px;margin-bottom:16px}
.tab{padding:6px 16px;border-radius:6px;background:#1e1e2e;border:1px solid #2a2a3e;cursor:pointer;color:#888;font-size:13px;transition:all .15s}
.tab.active{background:#4f46e5;border-color:#4f46e5;color:#fff}
.panel{display:none}.panel.active{display:block}
#fg-container{background:#141420;border-radius:10px;padding:16px;overflow-x:auto;min-height:120px}
.d3-flame-graph rect{stroke:#0f0f13;stroke-width:0.5px}
.d3-flame-graph text{font-size:11px}
.search-wrap{display:flex;gap:8px;margin-bottom:12px;align-items:center}
#fg-search{flex:1;max-width:320px;padding:6px 12px;border-radius:6px;background:#1e1e2e;border:1px solid #333;color:#e0e0e0;font-size:13px}
#fg-search:focus{outline:none;border-color:#4f46e5}
.notice{color:#444;font-size:11px;margin-top:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 12px;background:#1a1a2e;color:#888;font-weight:500;position:sticky;top:0}
td{padding:7px 12px;border-bottom:1px solid #1a1a2e}
tr:hover td{background:#1a1a2e}
.fn{color:#93c5fd;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:12px}
.src{color:#6b7280;font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-wrap{display:inline-block;width:80px;height:8px;background:#1e1e2e;border-radius:3px;vertical-align:middle;margin-right:6px}
.bar{height:100%;border-radius:3px;background:linear-gradient(90deg,#4f46e5,#7c3aed)}
a.btn-sm{text-decoration:none}
</style>
</head>
<body>
<h1>CPU Flamegraph</h1>
<p class="subtitle">V8 CPU Profiler — QuizGround Debug</p>

<div class="controls">
  <label for="seconds-slider">Duration</label>
  <input type="range" id="seconds-slider" min="10" max="120" value="30" step="5">
  <span id="seconds-val">30s</span>
  <button class="btn btn-primary" id="start-btn" onclick="startProfile()">&#9654; Start Profiling</button>
</div>

<div id="status-box">
  <div class="status-row">
    <div class="spinner"></div>
    <span id="status-text">Profiling...</span>
  </div>
  <progress id="prog" value="0" max="100"></progress>
</div>

<div id="error-box"></div>

<div id="results">
  <div class="results-header">
    <span class="results-meta" id="results-meta"></span>
    <div class="btn-group">
      <button class="btn-sm" onclick="resetUi()">&#8635; Re-profile</button>
      <a id="dl-btn" class="btn-sm">&#8659; .cpuprofile</a>
      <a href="https://speedscope.app" target="_blank" class="btn-sm">speedscope &#8599;</a>
    </div>
  </div>

  <div class="tabs">
    <button class="tab active" onclick="switchTab('flame',this)">Flame Graph</button>
    <button class="tab" onclick="switchTab('table',this)">Top Functions</button>
  </div>

  <div id="flame" class="panel active">
    <div class="search-wrap">
      <input id="fg-search" type="search" placeholder="Search functions..." oninput="searchFg(this.value)">
      <button class="btn-sm" onclick="clearSearch()">Clear</button>
    </div>
    <div id="fg-container"><div id="flamegraph"></div></div>
    <p class="notice">클릭: 줌인 &middot; 더블클릭(루트): 리셋 &middot; 검색: 함수명 하이라이트</p>
  </div>

  <div id="table" class="panel">
    <table>
      <thead><tr><th>#</th><th>Function</th><th>Source</th><th>Hits</th><th>Self %</th></tr></thead>
      <tbody id="top-tbody"></tbody>
    </table>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3-flame-graph@4/dist/d3-flamegraph.min.js"></script>
<script>
const TOKEN = ${safeToken};
let jobId = null, pollTimer = null, chart = null;

const startBtn = document.getElementById('start-btn');
const slider   = document.getElementById('seconds-slider');
const secVal   = document.getElementById('seconds-val');

slider.addEventListener('input', () => { secVal.textContent = slider.value + 's'; });

// ── Start profiling ───────────────────────────────────────────────────────
async function startProfile() {
  const seconds = slider.value;
  setUiState('running');

  try {
    const r = await fetch('/api/debug/flamegraph/start?token=' + TOKEN + '&seconds=' + seconds, { method: 'POST' });
    const body = await r.json();
    if (!r.ok) throw new Error(body.message || r.statusText);
    jobId = body.jobId;
    pollStatus(body.seconds);
  } catch(e) {
    showError(e.message);
  }
}

function pollStatus(total) {
  var retries502 = 0;
  pollTimer = setInterval(async () => {
    try {
      const r = await fetch('/api/debug/flamegraph/status?token=' + TOKEN + '&jobId=' + jobId);
      if (r.status === 502 || r.status === 503) {
        retries502++;
        if (retries502 <= 10) {
          document.getElementById('status-text').textContent = 'Profiling… (서버 응답 대기 중 ' + retries502 + '/10)';
          return;
        }
        clearInterval(pollTimer);
        showError('서버에 연결할 수 없습니다 (' + r.status + '). 부하가 줄어든 후 재시도하세요.');
        return;
      }
      retries502 = 0;
      const d = await r.json();
      if (!r.ok) {
        clearInterval(pollTimer);
        showError(d.message || ('Server error ' + r.status + ' — 서버가 재시작됐을 수 있습니다. 다시 시도하세요.'));
        return;
      }
      if (d.status === 'done') {
        clearInterval(pollTimer);
        document.getElementById('status-box').style.display = 'none';
        loadResult();
      } else if (d.status === 'error') {
        clearInterval(pollTimer);
        showError(d.error || 'Profiling failed');
      } else {
        var elapsed = typeof d.elapsed === 'number' ? d.elapsed : 0;
        var pct = total > 0 ? Math.min((elapsed / total) * 100, 99) : 0;
        document.getElementById('prog').value = pct;
        document.getElementById('status-text').textContent = 'Profiling… ' + (d.remaining != null ? d.remaining : '?') + 's remaining';
      }
    } catch(e) {
      clearInterval(pollTimer);
      showError(e.message);
    }
  }, 1000);
}

async function loadResult() {
  try {
    const r = await fetch('/api/debug/flamegraph/data?token=' + TOKEN + '&jobId=' + jobId);
    if (!r.ok) {
      var body = await r.text();
      var msg;
      try { msg = JSON.parse(body).message; } catch(_) { msg = body; }
      throw new Error(msg || ('HTTP ' + r.status + ' — 서버가 재시작됐을 수 있습니다. 다시 시도하세요.'));
    }
    const profile = await r.json();

    renderFlamegraph(profile);
    buildTopTable(profile);
    setupDownload(profile);

    const samples = (profile.samples || []).length;
    const durationMs = ((profile.timeDeltas || []).reduce((s, d) => s + d, 0) / 1000).toFixed(0);
    document.getElementById('results-meta').textContent =
      'Samples: ' + samples + '  |  Duration: ' + durationMs + 'ms  |  ' +
      new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

    document.getElementById('results').style.display = 'block';
    startBtn.disabled = false;
  } catch(e) {
    showError(e.message);
  }
}

// ── V8 Profile → d3-flame-graph hierarchy ────────────────────────────────
function v8ToD3(profile) {
  var nodeMap = new Map(profile.nodes.map(function(n) { return [n.id, n]; }));

  function convert(nodeId) {
    var node = nodeMap.get(nodeId);
    if (!node || !node.callFrame) return null;
    var fn   = node.callFrame.functionName || '(anonymous)';
    var url  = node.callFrame.url || '';
    var file = url.split('/').pop() || '';
    var line = node.callFrame.lineNumber || 0;
    var name = file ? fn + ' (' + file + ':' + line + ')' : fn;

    var children = (node.children || []).map(convert).filter(Boolean);
    var childVal = children.reduce(function(s, c) { return s + c.value; }, 0);
    var selfVal  = node.hitCount || 0;

    return { name: name, value: selfVal + childVal, children: children.length ? children : undefined };
  }

  var root = profile.nodes.find(function(n) { return n.id === 1; });
  if (!root) return { name: '(root)', value: 1 };
  var tree = convert(root.id);
  return tree && tree.value > 0 ? tree : { name: '(root)', value: 1 };
}

// ── Render flamegraph ─────────────────────────────────────────────────────
function renderFlamegraph(profile) {
  var container = document.getElementById('flamegraph');
  container.innerHTML = '';
  chart = null;

  var data = v8ToD3(profile);
  var width = Math.max(document.getElementById('fg-container').clientWidth - 32, 400);

  chart = flamegraph()
    .width(width)
    .cellHeight(18)
    .transitionDuration(400)
    .minFrameSize(5)
    .sort(true);

  d3.select('#flamegraph').datum(data).call(chart);
}

function searchFg(term) {
  if (!chart) return;
  term ? chart.search(term) : chart.resetHighlight();
}

function clearSearch() {
  document.getElementById('fg-search').value = '';
  if (chart) chart.resetHighlight();
}

// ── Top functions table ───────────────────────────────────────────────────
function buildTopTable(profile) {
  var nodes   = profile.nodes || [];
  var samples = (profile.samples || []).length;
  var total   = samples || nodes.reduce(function(s, n) { return s + (n.hitCount || 0); }, 0);

  var rows = nodes
    .filter(function(n) { return (n.hitCount || 0) > 0; })
    .sort(function(a, b) { return (b.hitCount || 0) - (a.hitCount || 0); })
    .slice(0, 50)
    .map(function(n, i) {
      var pct = total > 0 ? ((n.hitCount / total) * 100).toFixed(1) : '0.0';
      var fn  = esc(n.callFrame.functionName || '(anonymous)');
      var url = n.callFrame.url || '';
      var src = esc(url ? url.replace(/.*\\//, '') + ':' + n.callFrame.lineNumber : '');
      return '<tr><td>' + (i+1) + '</td>' +
             '<td class="fn" title="' + fn + '">' + fn + '</td>' +
             '<td class="src" title="' + src + '">' + src + '</td>' +
             '<td>' + (n.hitCount || 0) + '</td>' +
             '<td><span class="bar-wrap"><span class="bar" style="width:' + pct + '%"></span></span>' + pct + '%</td></tr>';
    });

  document.getElementById('top-tbody').innerHTML = rows.join('');
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Download ──────────────────────────────────────────────────────────────
function setupDownload(profile) {
  var blob = new Blob([JSON.stringify(profile)], { type: 'application/json' });
  var dl   = document.getElementById('dl-btn');
  if (dl._url) URL.revokeObjectURL(dl._url);
  dl._url   = URL.createObjectURL(blob);
  dl.href   = dl._url;
  dl.download = 'cpu-' + new Date().toISOString().slice(0,19).replace(/:/g,'-') + '.cpuprofile';
}

// ── UI helpers ────────────────────────────────────────────────────────────
function setUiState(state) {
  if (state === 'running') {
    startBtn.disabled = true;
    document.getElementById('status-box').style.display = 'block';
    document.getElementById('error-box').style.display  = 'none';
    document.getElementById('results').style.display    = 'none';
    document.getElementById('prog').value = 0;
    document.getElementById('status-text').textContent  = 'Starting…';
  }
}

function showError(msg) {
  clearInterval(pollTimer);
  document.getElementById('status-box').style.display = 'none';
  var eb = document.getElementById('error-box');
  eb.style.display = 'block';
  eb.textContent   = '❌ ' + msg;
  startBtn.disabled = false;
}

function resetUi() {
  clearInterval(pollTimer);
  document.getElementById('results').style.display = 'none';
  document.getElementById('flamegraph').innerHTML   = '';
  chart = null;
  startBtn.disabled = false;
}

function switchTab(id, el) {
  document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.tab').forEach(function(t)   { t.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
  el.classList.add('active');
}

window.addEventListener('resize', function() {
  if (!chart) return;
  var w = Math.max(document.getElementById('fg-container').clientWidth - 32, 400);
  chart.width(w);
});
</script>
</body>
</html>`;
}
