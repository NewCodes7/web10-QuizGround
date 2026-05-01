#!/bin/bash
# node_exporter 설치 스크립트 - node1, node2에서 실행
# 멱등성 보장: 이미 실행 중이면 스킵
set -e

NODE_EXPORTER_VERSION="1.8.1"
INSTALL_DIR="/usr/local/bin"
SERVICE_USER="node_exporter"

echo "▶ node_exporter 설치 시작 ($(date '+%Y-%m-%d %H:%M:%S'))"

# 이미 실행 중이면 스킵
if systemctl is-active --quiet node_exporter 2>/dev/null; then
  echo "  node_exporter 이미 실행 중 - 스킵"
  exit 0
fi

# ── 1. 바이너리 다운로드 및 설치 ─────────────────────────────────────
if [ ! -f "$INSTALL_DIR/node_exporter" ]; then
  echo "[SETUP] node_exporter v${NODE_EXPORTER_VERSION} 다운로드 중..."
  cd /tmp
  curl -fsSL \
    "https://github.com/prometheus/node_exporter/releases/download/v${NODE_EXPORTER_VERSION}/node_exporter-${NODE_EXPORTER_VERSION}.linux-amd64.tar.gz" \
    -o node_exporter.tar.gz
  tar -xzf node_exporter.tar.gz
  sudo mv "node_exporter-${NODE_EXPORTER_VERSION}.linux-amd64/node_exporter" "$INSTALL_DIR/"
  rm -rf node_exporter.tar.gz "node_exporter-${NODE_EXPORTER_VERSION}.linux-amd64"
  echo "[SETUP] node_exporter 바이너리 설치 완료"
fi

# ── 2. 시스템 유저 생성 ───────────────────────────────────────────────
if ! id -u "$SERVICE_USER" &>/dev/null; then
  sudo useradd --no-create-home --shell /bin/false "$SERVICE_USER"
fi
sudo chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/node_exporter"

# ── 3. systemd 서비스 등록 ────────────────────────────────────────────
sudo tee /etc/systemd/system/node_exporter.service > /dev/null << 'UNIT'
[Unit]
Description=Prometheus Node Exporter
Documentation=https://github.com/prometheus/node_exporter
After=network.target

[Service]
User=node_exporter
Group=node_exporter
Type=simple
ExecStart=/usr/local/bin/node_exporter \
  --web.listen-address=:9100 \
  --collector.disable-defaults \
  --collector.cpu \
  --collector.meminfo \
  --collector.diskstats \
  --collector.filesystem \
  --collector.netdev \
  --collector.loadavg \
  --collector.uname
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable node_exporter
sudo systemctl start node_exporter

echo ""
echo "✅ node_exporter 설치 완료 - port 9100 ($(date '+%Y-%m-%d %H:%M:%S'))"
