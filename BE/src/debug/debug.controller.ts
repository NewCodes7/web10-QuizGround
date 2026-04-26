import {
  Controller,
  Get,
  Query,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Response } from 'express';
import { Session } from 'node:inspector/promises';
import type { Profiler } from 'node:inspector';
import * as v8 from 'node:v8';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

@Controller('api/debug')
export class DebugController {
  /**
   * CPU 프로파일 수집 (V8 .cpuprofile)
   * 사용: curl "http://node1:3000/api/debug/profile?token=SECRET&seconds=30" -o cpu.cpuprofile
   * 분석: speedscope.app 또는 Chrome DevTools > Performance > Import
   */
  @Get('profile')
  async cpuProfile(
    @Query('token') token: string,
    @Query('seconds') seconds = '30',
    @Res() res: Response,
  ) {
    this.validateToken(token);

    const profile = await this.collectProfile(parseInt(seconds, 10) || 30);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="cpu-${Date.now()}.cpuprofile"`);
    res.send(JSON.stringify(profile));
  }

  /**
   * CPU 플레임그래프 (브라우저에서 바로 시각화)
   * 사용: 브라우저에서 http://node1:3000/api/debug/flamegraph?token=SECRET&seconds=30 접속
   */
  @Get('flamegraph')
  async flamegraph(
    @Query('token') token: string,
    @Query('seconds') seconds = '30',
    @Res() res: Response,
  ) {
    this.validateToken(token);

    const profile = await this.collectProfile(parseInt(seconds, 10) || 30);
    const html = buildFlameHtml(profile);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  private async collectProfile(seconds: number): Promise<Profiler.Profile> {
    const durationMs = Math.min(Math.max(seconds, 5), 60) * 1000;
    const session = new Session();
    session.connect();
    try {
      await session.post('Profiler.enable');
      await session.post('Profiler.start');
      await new Promise<void>(resolve => setTimeout(resolve, durationMs));
      const { profile } = await session.post('Profiler.stop');
      return profile;
    } finally {
      session.disconnect();
    }
  }

  /**
   * 힙 스냅샷 수집 (V8 .heapsnapshot)
   * 사용: curl "http://node1:3000/api/debug/heap?token=SECRET" -o heap.heapsnapshot
   * 분석: Chrome DevTools > Memory > Load
   */
  @Get('heap')
  heapSnapshot(@Query('token') token: string, @Res() res: Response) {
    this.validateToken(token);

    const filePath = v8.writeHeapSnapshot(os.tmpdir());
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.sendFile(filePath, err => {
      fs.unlink(filePath, () => {});
      if (err && !res.headersSent) res.status(500).end();
    });
  }

  private validateToken(token: string) {
    const expected = process.env.DEBUG_TOKEN;
    if (!expected) throw new ServiceUnavailableException('DEBUG_TOKEN not configured');
    if (token !== expected) throw new UnauthorizedException();
  }
}

// ─── HTML Flamegraph Builder ────────────────────────────────────────────────

interface CpuNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
  children?: number[];
}

function buildFlameHtml(profile: { nodes: CpuNode[]; samples?: number[]; timeDeltas?: number[] }): string {
  const { nodes, samples = [], timeDeltas = [] } = profile;

  // ── 1. top functions by self hitCount ──
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const totalSamples = samples.length || nodes.reduce((s, n) => s + (n.hitCount ?? 0), 0);
  const durationMs = timeDeltas.reduce((s, d) => s + d, 0) / 1000;

  const ranked = [...nodes]
    .filter(n => (n.hitCount ?? 0) > 0)
    .sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0))
    .slice(0, 40)
    .map(n => {
      const pct = totalSamples > 0 ? (((n.hitCount ?? 0) / totalSamples) * 100).toFixed(1) : '0.0';
      const fn = n.callFrame.functionName || '(anonymous)';
      const src = n.callFrame.url
        ? `${n.callFrame.url.replace(/.*\//, '')}:${n.callFrame.lineNumber}`
        : '';
      return { fn, src, hits: n.hitCount ?? 0, pct };
    });

  // ── 2. call-stack flame data from samples ──
  const parentMap = new Map<number, number>();
  for (const node of nodes) {
    for (const childId of node.children ?? []) {
      parentMap.set(childId, node.id);
    }
  }

  // aggregate (stack → count)
  const stackCounts = new Map<string, number>();
  for (const sampleId of samples) {
    const stack: string[] = [];
    let id: number | undefined = sampleId;
    while (id !== undefined) {
      const node = nodeMap.get(id);
      if (!node) break;
      const fn = node.callFrame.functionName || '(anon)';
      stack.unshift(fn);
      id = parentMap.get(id);
    }
    const key = stack.join(';');
    stackCounts.set(key, (stackCounts.get(key) ?? 0) + 1);
  }

  // collapsed stacks format for canvas renderer
  const stacksJson = JSON.stringify(
    [...stackCounts.entries()].map(([stack, count]) => ({ stack, count })),
  );

  const rowsHtml = ranked
    .map(
      (r, i) => `<tr>
        <td>${i + 1}</td>
        <td class="fn">${esc(r.fn)}</td>
        <td class="src">${esc(r.src)}</td>
        <td>${r.hits}</td>
        <td>
          <div class="bar-wrap"><div class="bar" style="width:${r.pct}%"></div></div>
          ${r.pct}%
        </td>
      </tr>`,
    )
    .join('');

  const profileJson = JSON.stringify(profile);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>CPU Flamegraph</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:14px/1.5 'Segoe UI',system-ui,sans-serif;background:#0f0f13;color:#e0e0e0;padding:24px}
  h1{font-size:20px;margin-bottom:4px;color:#fff}
  .meta{color:#888;font-size:12px;margin-bottom:20px}
  .tabs{display:flex;gap:8px;margin-bottom:16px}
  .tab{padding:6px 16px;border-radius:6px;background:#1e1e2e;border:1px solid #333;cursor:pointer;color:#aaa;font-size:13px}
  .tab.active{background:#4f46e5;border-color:#4f46e5;color:#fff}
  .panel{display:none}.panel.active{display:block}
  /* table */
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:8px 12px;background:#1a1a2e;color:#888;font-weight:500;position:sticky;top:0}
  td{padding:7px 12px;border-bottom:1px solid #1e1e2e}
  tr:hover td{background:#1a1a2e}
  .fn{color:#93c5fd;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .src{color:#6b7280;font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bar-wrap{display:inline-block;width:80px;height:10px;background:#1e1e2e;border-radius:3px;vertical-align:middle;margin-right:6px}
  .bar{height:100%;border-radius:3px;background:linear-gradient(90deg,#4f46e5,#7c3aed)}
  /* canvas */
  #canvas-wrap{overflow:auto;background:#141414;border-radius:8px}
  canvas{display:block;cursor:crosshair}
  #tooltip{position:fixed;background:#1e1e2e;border:1px solid #333;border-radius:6px;padding:8px 12px;font-size:12px;pointer-events:none;display:none;max-width:400px;word-break:break-all;z-index:9}
  .btn{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:6px;background:#4f46e5;color:#fff;font-size:13px;border:none;cursor:pointer;margin-bottom:16px}
  .btn:hover{background:#4338ca}
  .notice{color:#6b7280;font-size:12px;margin-top:12px}
</style>
</head>
<body>
<h1>CPU Flamegraph</h1>
<div class="meta">
  Duration: <b>${durationMs.toFixed(0)} ms</b> &nbsp;|&nbsp;
  Samples: <b>${totalSamples}</b> &nbsp;|&nbsp;
  Collected: <b>${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</b>
</div>

<button class="btn" onclick="download()">&#8659; .cpuprofile 다운로드</button>

<div class="tabs">
  <button class="tab active" onclick="switchTab('flame',this)">Flame Graph</button>
  <button class="tab" onclick="switchTab('table',this)">Top Functions</button>
</div>

<div id="flame" class="panel active">
  <div id="canvas-wrap"><canvas id="fg"></canvas></div>
  <div id="tooltip"></div>
  <p class="notice">클릭으로 확대 · 우클릭으로 축소 · 마우스 오버로 함수 정보</p>
</div>

<div id="table" class="panel">
  <table>
    <thead><tr><th>#</th><th>Function</th><th>Source</th><th>Hits</th><th>Self %</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</div>

<script>
const STACKS = ${stacksJson};
const PROFILE_JSON = ${profileJson};

// ── flamegraph renderer ──────────────────────────────────────────────
const COLORS = ['#4f46e5','#7c3aed','#0ea5e9','#06b6d4','#10b981','#84cc16','#f59e0b','#ef4444'];
function color(name) {
  let h = 0; for (let i=0; i<name.length; i++) h = (h*31+name.charCodeAt(i))>>>0;
  return COLORS[h % COLORS.length];
}

let root, canvas, ctx, tooltip, viewStack = [];

function buildTree() {
  const tree = {};
  for (const {stack, count} of STACKS) {
    const frames = stack.split(';');
    let node = tree;
    for (const f of frames) {
      node[f] = node[f] || { _count: 0, _self: 0 };
      node[f]._count += count;
      node = node[f];
    }
    // last frame gets self count
    const last = frames.reduce((n,f)=>n[f], tree);
    last._self += count;
  }
  return tree;
}

function flattenTree(node, name, depth, start, total, out) {
  const w = node._count / total;
  out.push({ name, depth, x: start, w, self: node._self });
  const children = Object.entries(node).filter(([k])=>!k.startsWith('_'));
  children.sort((a,b)=>b[1]._count - a[1]._count);
  let cx = start;
  for (const [k,v] of children) {
    flattenTree(v, k, depth+1, cx, total, out);
    cx += v._count / total;
  }
}

function render() {
  if (!STACKS.length) {
    ctx.fillStyle = '#888';
    ctx.font = '14px sans-serif';
    ctx.fillText('샘플 데이터 없음 — samples[] 배열이 비어있습니다', 20, 40);
    return;
  }

  const tree = buildTree();
  const total = Object.values(tree).reduce((s,v)=>s+(v._count||0),0) || 1;
  const bars = [];
  for (const [k,v] of Object.entries(tree)) flattenTree(v, k, 0, 0, total, bars);
  if (!bars.length) return;

  const maxDepth = bars.reduce((m,b)=>Math.max(m,b.depth),0);
  const ROW = 22;
  const W = canvas.parentElement.clientWidth || 1200;
  canvas.width = W;
  canvas.height = (maxDepth + 1) * ROW + 4;
  canvas.style.width = W + 'px';
  canvas.style.height = canvas.height + 'px';

  // current view defines zoom
  const [viewX, viewW] = viewStack.length ? viewStack[viewStack.length-1] : [0, 1];

  ctx.clearRect(0, 0, W, canvas.height);
  ctx.font = '11px "Segoe UI",sans-serif';

  canvas._bars = bars;
  canvas._ROW = ROW;
  canvas._W = W;
  canvas._viewX = viewX;
  canvas._viewW = viewW;

  for (const b of bars) {
    // transform to view
    const rx = (b.x - viewX) / viewW;
    const rw = b.w / viewW;
    if (rx + rw < 0 || rx > 1) continue;
    const px = Math.max(rx * W, 0);
    const pw = Math.min(rw * W, W - px);
    if (pw < 1) continue;

    const y = (maxDepth - b.depth) * ROW;
    ctx.fillStyle = color(b.name);
    ctx.fillRect(px+1, y+1, pw-2, ROW-2);

    if (pw > 30) {
      ctx.fillStyle = '#fff';
      ctx.save();
      ctx.rect(px+2, y, pw-4, ROW);
      ctx.clip();
      ctx.fillText(b.name, px+4, y+15);
      ctx.restore();
    }
  }
}

function initCanvas() {
  canvas = document.getElementById('fg');
  ctx = canvas.getContext('2d');
  tooltip = document.getElementById('tooltip');

  canvas.addEventListener('mousemove', e => {
    const b = hitTest(e);
    if (!b) { tooltip.style.display='none'; return; }
    const pct = (b.w*100).toFixed(2);
    const self = (b.self/(canvas._bars.reduce((s,x)=>x.depth===0?s+x.w:s,0)||1)*100).toFixed(2);
    tooltip.innerHTML = \`<b>\${b.name}</b><br>Total: \${pct}% · Self: \${self}%\`;
    tooltip.style.display='block';
    tooltip.style.left = (e.clientX+12)+'px';
    tooltip.style.top = (e.clientY+12)+'px';
  });
  canvas.addEventListener('mouseleave', ()=>{ tooltip.style.display='none'; });
  canvas.addEventListener('click', e => {
    const b = hitTest(e);
    if (!b) return;
    viewStack.push([b.x, b.w]);
    render();
  });
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (viewStack.length) { viewStack.pop(); render(); }
  });

  render();
}

function hitTest(e) {
  if (!canvas._bars) return null;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const maxDepth = canvas._bars.reduce((m,b)=>Math.max(m,b.depth),0);
  const ROW = canvas._ROW, W = canvas._W;
  const viewX = canvas._viewX, viewW = canvas._viewW;
  for (const b of canvas._bars) {
    const rx = (b.x - viewX) / viewW;
    const rw = b.w / viewW;
    const px = Math.max(rx * W, 0);
    const pw = Math.min(rw * W, W - px);
    const y = (maxDepth - b.depth) * ROW;
    if (mx >= px && mx <= px+pw && my >= y && my <= y+ROW) return b;
  }
  return null;
}

// ── tab switch ──────────────────────────────────────────────────────
function switchTab(id, el) {
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  el.classList.add('active');
  if (id === 'flame') render();
}

// ── download ────────────────────────────────────────────────────────
function download() {
  const blob = new Blob([JSON.stringify(PROFILE_JSON)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cpu-${Date.now()}.cpuprofile';
  a.click();
}

window.addEventListener('load', initCanvas);
window.addEventListener('resize', ()=>{ if(document.getElementById('flame').classList.contains('active')) render(); });
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
