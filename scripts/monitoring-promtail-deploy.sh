#!/bin/bash
# Promtail 설치 스크립트 - node1, node2에서 실행
# 인수: $1 = LOKI_INTERNAL_IP (nginx VM 내부 IP), $2 = INSTANCE_LABEL (node1 or node2)
# 멱등성 보장: 설정 변경 시 자동 재시작
set -e

PROMTAIL_VERSION="2.9.10"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/promtail"
LOKI_INTERNAL_IP="${1:?LOKI_INTERNAL_IP 인수가 필요합니다 (nginx VM 내부 IP)}"
INSTANCE_LABEL="${2:?INSTANCE_LABEL 인수가 필요합니다 (node1 또는 node2)}"
PM2_USER="$USER"

echo "▶ Promtail 설치 시작 ($(date '+%Y-%m-%d %H:%M:%S'))"
echo "  Loki URL: http://${LOKI_INTERNAL_IP}:3100"
echo "  Instance: ${INSTANCE_LABEL}"

# ── 1. 바이너리 설치 ──────────────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/promtail" ]; then
  echo "[SETUP] Promtail v${PROMTAIL_VERSION} 다운로드 중..."
  cd /tmp
  curl -fsSL \
    "https://github.com/grafana/loki/releases/download/v${PROMTAIL_VERSION}/promtail-linux-amd64.zip" \
    -o promtail.zip
  sudo apt-get install -y unzip -qq
  unzip -q promtail.zip
  sudo mv promtail-linux-amd64 "$INSTALL_DIR/promtail"
  sudo chmod +x "$INSTALL_DIR/promtail"
  rm -f promtail.zip
  echo "[SETUP] Promtail 바이너리 설치 완료"
fi

# ── 2. 설정 디렉토리 및 파일 생성 ────────────────────────────────────
sudo mkdir -p "$CONFIG_DIR"

sudo tee "$CONFIG_DIR/promtail.yml" > /dev/null << EOF
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/promtail-positions.yaml

clients:
  - url: http://${LOKI_INTERNAL_IP}:3100/loki/api/v1/push

scrape_configs:
  - job_name: was
    static_configs:
      - targets:
          - localhost
        labels:
          job: was
          instance: ${INSTANCE_LABEL}
          __path__: /home/${PM2_USER}/.pm2/logs/quiz-ground-was-out.log

  - job_name: was-error
    static_configs:
      - targets:
          - localhost
        labels:
          job: was-error
          instance: ${INSTANCE_LABEL}
          __path__: /home/${PM2_USER}/.pm2/logs/quiz-ground-was-error.log
EOF

# ── 3. systemd 서비스 등록 ────────────────────────────────────────────
sudo tee /etc/systemd/system/promtail.service > /dev/null << 'UNIT'
[Unit]
Description=Grafana Promtail (log shipper)
Documentation=https://grafana.com/docs/loki/latest/send-data/promtail/
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/promtail -config.file=/etc/promtail/promtail.yml
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable promtail

# 이미 실행 중이면 재시작(설정 변경 반영), 처음이면 시작
if systemctl is-active --quiet promtail; then
  sudo systemctl restart promtail
  echo "  Promtail 재시작 완료 (설정 갱신)"
else
  sudo systemctl start promtail
fi

echo ""
echo "✅ Promtail 설치 완료 ($(date '+%Y-%m-%d %H:%M:%S'))"
