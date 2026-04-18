#!/bin/bash
# nginx 서버 배포 스크립트
# - FE 정적 파일 배포 + upstream 설정 갱신
# - 최초 배포(nginx 미설치) & 재배포 모두 처리
# 필수 환경변수: NODE1_INTERNAL_IP, NODE2_INTERNAL_IP
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOBE_DIR="$(dirname "$SCRIPT_DIR")"       # scripts/의 부모 = tobe/

# 필수 환경변수 검증
: "${NODE1_INTERNAL_IP:?NODE1_INTERNAL_IP 환경변수가 설정되지 않았습니다}"
: "${NODE2_INTERNAL_IP:?NODE2_INTERNAL_IP 환경변수가 설정되지 않았습니다}"

echo "▶ nginx 배포 시작 ($(date '+%Y-%m-%d %H:%M:%S'))"
echo "  upstream: $NODE1_INTERNAL_IP:3000, $NODE2_INTERNAL_IP:3000"

# ── 1. nginx 설치 확인 (최초 배포 시) ────────────────────────────
if ! command -v nginx &>/dev/null; then
  echo "[SETUP] nginx 설치 중..."
  sudo apt-get update
  sudo apt-get install -y nginx
fi

# ── 2. nginx 설정 생성 (항상 갱신 - 내부 IP 변경 반영) ───────────
# IP가 바뀔 수 있으므로 매 배포마다 설정 파일을 재생성
echo "[DEPLOY] nginx upstream 설정 업데이트 중..."
sudo tee /etc/nginx/sites-available/quizground > /dev/null << NGINX_CONF
upstream quizground_backend {
    # Socket.IO sticky session: 같은 클라이언트는 같은 WAS로 라우팅
    ip_hash;
    server ${NODE1_INTERNAL_IP}:3000;
    server ${NODE2_INTERNAL_IP}:3000;
}

server {
    listen 80;
    root /var/www/html;
    index index.html;

    # FE - React SPA 라우팅
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # BE - Socket.IO WebSocket + API 프록시
    location /game {
        proxy_pass http://quizground_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        # WebSocket 연결 유지 (장시간 게임 세션 대응)
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
NGINX_CONF

# sites-enabled 심볼릭 링크 등록 (최초 1회)
if [ ! -L /etc/nginx/sites-enabled/quizground ]; then
  echo "[SETUP] nginx sites-enabled 설정 중..."
  sudo ln -sf /etc/nginx/sites-available/quizground /etc/nginx/sites-enabled/quizground
  sudo rm -f /etc/nginx/sites-enabled/default
fi

# ── 3. FE 정적 파일 배포 ──────────────────────────────────────────
echo "[DEPLOY] FE 정적 파일 배포 중..."
sudo rm -rf /var/www/html/*
sudo cp -r "$TOBE_DIR/FE/dist/." /var/www/html/

# ── 4. nginx 설정 검증 후 적용 ────────────────────────────────────
echo "[DEPLOY] nginx 설정 적용 중..."
sudo nginx -t
sudo systemctl reload nginx 2>/dev/null || sudo systemctl start nginx

# ── 5. 사용 완료된 tobe 디렉토리 정리 ────────────────────────────
rm -rf "$TOBE_DIR"

echo ""
echo "✅ nginx 배포 완료 ($(date '+%Y-%m-%d %H:%M:%S'))"
