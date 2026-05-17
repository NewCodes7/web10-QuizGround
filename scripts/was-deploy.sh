#!/bin/bash
# WAS 서버(node-1 / node-2) 배포 스크립트
# - 최초 배포(Node.js/PM2 미설치) & 재배포 모두 처리
# - pm2 delete + start로 node_args 등 모든 설정 반영
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOBE_DIR="$(dirname "$SCRIPT_DIR")"       # scripts/의 부모 = tobe/
DEPLOY_DIR="$(dirname "$TOBE_DIR")"       # tobe/의 부모   = quizground/
CURRENT_DIR="$DEPLOY_DIR/current"

echo "▶ WAS 배포 시작 ($(date '+%Y-%m-%d %H:%M:%S'))"

# ── 1. Node.js 설치/업그레이드 확인 ──────────────────────────────
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo "0")
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "[SETUP] Node.js 24 설치/업그레이드 중... (현재: $(node -v 2>/dev/null || echo 없음))"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  Node.js: $(node -v)"

# ── 2. PM2 설치 + 부팅 자동시작 등록 (최초 배포 시) ──────────────
if ! command -v pm2 &>/dev/null; then
  echo "[SETUP] PM2 설치 중..."
  sudo npm install -g pm2
  # 서버 재부팅 시 PM2 자동 시작 (systemd 등록)
  pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | sudo bash
fi
echo "  PM2: $(pm2 -v)"

# ── 3. BE 프로덕션 의존성 설치 ────────────────────────────────────
echo "[DEPLOY] BE 의존성 설치 중..."
cd "$TOBE_DIR/BE"
npm ci --omit=dev

# ── 4. 배포 디렉토리 교체 ─────────────────────────────────────────
# tobe/ → current/ 로 원자적 교체
echo "[DEPLOY] 디렉토리 교체 중 (tobe → current)..."
rm -rf "$CURRENT_DIR"
mv "$TOBE_DIR" "$CURRENT_DIR"
mkdir -p "$DEPLOY_DIR/tobe"  # 다음 배포를 위해 재생성

# ── 5. PM2로 BE 실행 ──────────────────────────────────────────────
# node_args(--heap-prof 등) 변경은 reload --update-env로 반영되지 않음
# → delete + start로 항상 새 설정을 적용
CPU_COUNT=$(nproc)
echo "[DEPLOY] PM2 프로세스 시작/재시작 중... (CPU: ${CPU_COUNT}코어, instances=max)"
cd "$CURRENT_DIR/BE"
pm2 delete quiz-ground-was 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save  # 서버 재부팅 후에도 자동 복구

echo ""
echo "✅ WAS 배포 완료 ($(date '+%Y-%m-%d %H:%M:%S'))"
pm2 list
