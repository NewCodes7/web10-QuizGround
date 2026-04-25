#!/bin/bash
# WAS 서버(node-1 / node-2) 배포 스크립트
# - 최초 배포(Node.js/PM2 미설치) & 재배포 모두 처리
# - pm2 reload로 zero-downtime 재시작
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOBE_DIR="$(dirname "$SCRIPT_DIR")"       # scripts/의 부모 = tobe/
DEPLOY_DIR="$(dirname "$TOBE_DIR")"       # tobe/의 부모   = quizground/
CURRENT_DIR="$DEPLOY_DIR/current"

echo "▶ WAS 배포 시작 ($(date '+%Y-%m-%d %H:%M:%S'))"

# ── 1. Node.js 설치 확인 (최초 배포 시) ──────────────────────────
if ! command -v node &>/dev/null; then
  echo "[SETUP] Node.js 20 설치 중..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
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
# .env의 환경변수(PYROSCOPE_SERVER_URL 등)를 PM2 프로세스에 주입
ENV_FILE="$CURRENT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# reload  : 기존 프로세스 있을 때 zero-downtime 재시작
# start   : 최초 배포 시 fallback
echo "[DEPLOY] PM2 프로세스 시작/재시작 중..."
cd "$CURRENT_DIR/BE"
pm2 reload ecosystem.config.js --update-env 2>/dev/null \
  || pm2 start ecosystem.config.js
pm2 save  # 서버 재부팅 후에도 자동 복구

echo ""
echo "✅ WAS 배포 완료 ($(date '+%Y-%m-%d %H:%M:%S'))"
pm2 list
