#!/bin/bash
# 모니터링 스택 배포 스크립트 - nginx VM에서 실행
# Prometheus + Grafana + redis_exporter + nginx_exporter (Docker Compose)
# 필수 환경변수: NODE1_INTERNAL_IP, NODE2_INTERNAL_IP, REDIS_INTERNAL_IP, GRAFANA_ADMIN_PASSWORD
set -e

: "${NODE1_INTERNAL_IP:?NODE1_INTERNAL_IP 환경변수가 설정되지 않았습니다}"
: "${NODE2_INTERNAL_IP:?NODE2_INTERNAL_IP 환경변수가 설정되지 않았습니다}"
: "${REDIS_INTERNAL_IP:?REDIS_INTERNAL_IP 환경변수가 설정되지 않았습니다}"
: "${GRAFANA_ADMIN_PASSWORD:?GRAFANA_ADMIN_PASSWORD 환경변수가 설정되지 않았습니다}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOBE_DIR="$(dirname "$SCRIPT_DIR")"
DEPLOY_DIR="/opt/quizground-monitoring"

echo "▶ 모니터링 스택 배포 시작 ($(date '+%Y-%m-%d %H:%M:%S'))"

# ── 1. Docker 설치 확인 ───────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "[SETUP] Docker 설치 중..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "[SETUP] Docker 설치 완료"
fi

# docker compose v2 플러그인 확인
if ! sudo docker compose version &>/dev/null; then
  echo "[SETUP] Docker Compose 플러그인 설치 중..."
  sudo apt-get install -y docker-compose-plugin
fi

# ── 2. 배포 디렉토리 준비 ─────────────────────────────────────────────
sudo mkdir -p "$DEPLOY_DIR"
sudo chown "$USER:$USER" "$DEPLOY_DIR"
cp -r "$TOBE_DIR/monitoring/." "$DEPLOY_DIR/"

# ── 3. prometheus.yml 생성 (envsubst로 IP 치환) ───────────────────────
echo "[DEPLOY] prometheus.yml 생성 중 (내부 IP 치환)..."
export NODE1_INTERNAL_IP NODE2_INTERNAL_IP REDIS_INTERNAL_IP
envsubst '${NODE1_INTERNAL_IP} ${NODE2_INTERNAL_IP} ${REDIS_INTERNAL_IP}' \
  < "$DEPLOY_DIR/prometheus/prometheus.yml.template" \
  > "$DEPLOY_DIR/prometheus/prometheus.yml"

# ── 4. .env 파일 생성 (Docker Compose 환경변수) ───────────────────────
cat > "$DEPLOY_DIR/.env" << EOF
REDIS_INTERNAL_IP=${REDIS_INTERNAL_IP}
GRAFANA_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
GRAFANA_ADMIN_USER=admin
EOF
chmod 600 "$DEPLOY_DIR/.env"

# ── 5. Docker Compose 실행 ────────────────────────────────────────────
echo "[DEPLOY] Docker Compose 시작/재시작 중..."
cd "$DEPLOY_DIR"
sudo docker compose pull --quiet
sudo docker compose up -d --remove-orphans

# ── 6. 헬스체크 ──────────────────────────────────────────────────────
echo "[DEPLOY] 헬스체크 대기 (60s)..."
sleep 60

HEALTH_OK=true

if curl -sf http://localhost:9090/-/healthy > /dev/null 2>&1; then
  echo "  Prometheus: OK"
else
  echo "  Prometheus: FAILED"
  HEALTH_OK=false
fi

# sub-path 모드이므로 /grafana/api/health 사용
if curl -sf http://localhost:3001/grafana/api/health > /dev/null 2>&1; then
  echo "  Grafana: OK"
else
  echo "  Grafana: FAILED"
  HEALTH_OK=false
fi

if [ "$HEALTH_OK" = false ]; then
  echo "헬스체크 실패. 로그 확인:"
  sudo docker compose logs --tail=20
  exit 1
fi

echo ""
echo "✅ 모니터링 스택 배포 완료 ($(date '+%Y-%m-%d %H:%M:%S'))"
echo "   Grafana: http://<nginx-외부IP>/grafana/  (admin / \$GRAFANA_ADMIN_PASSWORD)"
echo "   Prometheus: http://localhost:9090 (nginx VM 내부에서만 접근 가능)"
