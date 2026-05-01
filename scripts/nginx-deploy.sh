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
  echo "[SETUP] nginx 설치 중 (mainline 1.29.6+)..."
  sudo apt-get update
  sudo apt-get install -y curl gnupg2 lsb-release
  curl -fsSL https://nginx.org/keys/nginx_signing.key \
    | sudo gpg --dearmor -o /usr/share/keyrings/nginx-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] \
http://nginx.org/packages/mainline/ubuntu $(lsb_release -cs) nginx" \
    | sudo tee /etc/apt/sources.list.d/nginx.list
  sudo apt-get update
  sudo apt-get install -y nginx
fi

# ── 2. nginx 설정 생성 (항상 갱신 - 내부 IP 변경 반영) ───────────
# IP가 바뀔 수 있으므로 매 배포마다 설정 파일을 재생성
echo "[DEPLOY] nginx upstream 설정 업데이트 중..."
sudo tee /etc/nginx/conf.d/quizground.conf > /dev/null << NGINX_CONF
upstream quizground_backend {
    # Socket.IO sticky session: cookie로 같은 클라이언트를 같은 WAS로 고정
    sticky cookie quizground_srv expires=1h path=/ httponly samesite=lax;
    server ${NODE1_INTERNAL_IP}:3000;
    server ${NODE2_INTERNAL_IP}:3000;
}

# nginx_exporter용 stub_status (localhost + Docker bridge에서만 접근 가능)
server {
    listen 127.0.0.1:8080;
    listen 172.17.0.1:8080;
    server_name _;
    location /stub_status {
        stub_status;
    }
}

server {
    listen 80;
    root /var/www/html;
    index index.html;

    # Grafana 모니터링 대시보드 프록시 (Docker 컨테이너 localhost:3001)
    # serve_from_sub_path=true 이므로 trailing slash 없이 /grafana/ 경로 유지
    location /grafana/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$http_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # FE - React SPA 라우팅
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # BE - Socket.IO 폴링/WebSocket 트랜스포트 프록시
    # socket.IO는 네임스페이스(/game)와 무관하게 /socket.io/ 경로로 HTTP 요청을 보냄
    location /socket.io/ {
        proxy_pass http://quizground_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    # BE - REST API 프록시
    location /api/ {
        proxy_pass http://quizground_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
NGINX_CONF

# nginx.org mainline 패키지는 conf.d/default.conf를 기본 제공 → 충돌 방지
sudo rm -f /etc/nginx/conf.d/default.conf

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
