#!/bin/bash
# nginx 서버 배포 스크립트
# - FE 정적 파일 배포 + Grafana 프록시 설정 갱신
# - WS/API는 클라이언트가 WAS 노드에 직접 연결 (nginx 미경유)
# - 최초 배포(nginx 미설치) & 재배포 모두 처리
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOBE_DIR="$(dirname "$SCRIPT_DIR")"       # scripts/의 부모 = tobe/

echo "▶ nginx 배포 시작 ($(date '+%Y-%m-%d %H:%M:%S'))"

# ── 1. nginx 설치 확인 (최초 배포 시) ────────────────────────────
if ! command -v nginx &>/dev/null; then
  echo "[SETUP] nginx 설치 중 (mainline)..."
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

# ── 2. nginx 설정 생성 ─────────────────────────────────────────────
echo "[DEPLOY] nginx 설정 업데이트 중..."
sudo tee /etc/nginx/conf.d/quizground.conf > /dev/null << 'NGINX_CONF'
log_format json_combined escape=json
    '{"time":"$time_iso8601","remote_addr":"$remote_addr","method":"$request_method",'
    '"uri":"$uri","status":$status,"bytes_sent":$body_bytes_sent,'
    '"request_time":$request_time,"user_agent":"$http_user_agent"}';

map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
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

    access_log /var/log/nginx/access.log json_combined;

    # Grafana 모니터링 대시보드 프록시
    location /grafana/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # FE - React SPA 라우팅
    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX_CONF

sudo rm -f /etc/nginx/conf.d/default.conf

# ── 3. FE 정적 파일 배포 ──────────────────────────────────────────
echo "[DEPLOY] FE 정적 파일 배포 중..."
sudo rm -rf /var/www/html/*
sudo cp -r "$TOBE_DIR/FE/dist/." /var/www/html/

# ── 4. nginx 설정 검증 후 적용 ────────────────────────────────────
echo "[DEPLOY] nginx 설정 적용 중..."
sudo nginx -t
sudo systemctl reload nginx 2>/dev/null || sudo systemctl start nginx

rm -rf "$TOBE_DIR"

echo ""
echo "✅ nginx 배포 완료 ($(date '+%Y-%m-%d %H:%M:%S'))"
