# QuizGround 배포 가이드 (GCE 분산 환경)

## 아키텍처

```
인터넷
  │
  ▼
nginx VM (:80)          ← FE 정적 파일 서빙 + BE 리버스 프록시 (외부 IP 보유)
  │  ip_hash upstream
  ├──▶ node-1 VM (:3000)  ← NestJS WAS (내부 IP만)
  └──▶ node-2 VM (:3000)  ← NestJS WAS (내부 IP만)
            │
     quizground VPC 내부망
            ├──▶ mysql VM (:3306)
            └──▶ redis VM (:6379)
```

**네트워크**: 모든 VM은 `quizground` VPC 단일 네트워크에만 연결.  
node/mysql/redis VM은 외부 IP 없음. nginx VM만 외부 IP 보유 (CI/CD bastion 겸용).

## 배포 흐름 (CI/CD)

`release` 브랜치에 push하면 GitHub Actions가 자동 실행됩니다.

```
push to release
    │
    ▼
[1] build job
    ├─ BE/FE 빌드
    ├─ be.tar.gz 생성 (BE 빌드 결과물 + was-deploy.sh)
    └─ fe.tar.gz 생성 (FE 빌드 결과물 + nginx-deploy.sh)
    │
    ▼
[2] deploy-node1 job
    └─ nginx를 jump host로 경유 → node-1에 scp 전송 → was-deploy.sh → PM2 reload
    │
    ▼  (node-1 완료 후 시작 → rolling deploy)
[3] deploy-node2 job
    └─ nginx를 jump host로 경유 → node-2에 scp 전송 → was-deploy.sh → PM2 reload
    │
    ▼
[4] deploy-nginx job
    └─ nginx에 scp 전송 → nginx-deploy.sh → nginx reload
```

**Rolling 배포**: node-1 배포 중 node-2가 트래픽 처리 → node-2 배포 중 node-1이 처리.  
무중단 배포가 보장됩니다.

---

## 최초 배포 전 설정

### 1. VPC 네트워크 생성

```bash
# quizground VPC 생성 (커스텀 서브넷 모드)
gcloud compute networks create quizground --subnet-mode=custom

# 서브넷 생성 (리전은 VM과 동일하게)
gcloud compute networks subnets create quizground-subnet \
  --network=quizground \
  --region=asia-northeast3 \
  --range=10.10.0.0/16
```

### 2. GCE VM 생성 (5대)

| VM 이름 | 역할 | 권장 사양 | 외부 IP | 네트워크 태그 |
|---------|------|-----------|---------|--------------|
| quizground-nginx | 리버스 프록시 + FE + bastion | e2-micro | 필요 | `quizground-nginx` |
| quizground-node1 | NestJS WAS | e2-small | 없음 | `quizground-was` |
| quizground-node2 | NestJS WAS | e2-small | 없음 | `quizground-was` |
| quizground-mysql | MySQL 8.0 | e2-small | 없음 | `quizground-mysql` |
| quizground-redis | Redis | e2-micro | 없음 | `quizground-redis` |

> **중요**: 모든 VM을 `quizground` VPC **하나의 네트워크에만** 연결해야 합니다.  
> VM 생성 시 default 네트워크에 추가로 붙이면 비대칭 라우팅으로 내부망 SSH가 실패합니다.

VM 생성 예시:
```bash
# nginx (외부 IP 있음)
gcloud compute instances create quizground-nginx \
  --zone=asia-northeast3-a \
  --machine-type=e2-micro \
  --network=quizground \
  --subnet=quizground-subnet \
  --tags=quizground-nginx

# node1 (외부 IP 없음)
gcloud compute instances create quizground-node1 \
  --zone=asia-northeast3-a \
  --machine-type=e2-small \
  --network=quizground \
  --subnet=quizground-subnet \
  --no-address \
  --tags=quizground-was
```

### 3. 방화벽 규칙 생성

모든 규칙은 `quizground` 네트워크에 생성합니다.

```bash
# nginx: 외부에서 HTTP 허용
gcloud compute firewall-rules create quizground-allow-http \
  --network=quizground \
  --allow=tcp:80 \
  --target-tags=quizground-nginx

# 내부망 전체 통신 허용 (nginx↔node SSH, node↔mysql/redis 등)
gcloud compute firewall-rules create quizground-allow-internal \
  --network=quizground \
  --allow=tcp:0-65535,udp:0-65535,icmp \
  --source-ranges=10.10.0.0/16

# nginx에 외부 SSH 허용 (GitHub Actions CI/CD 접속용)
# quizground VPC 생성 시 quizground-allow-ssh가 자동 생성되므로 이미 있을 수 있음
gcloud compute firewall-rules create quizground-allow-ssh \
  --network=quizground \
  --allow=tcp:22 \
  --target-tags=quizground-nginx
```

> `quizground-allow-ssh`는 VPC 생성 시 자동으로 만들어졌을 수 있습니다.  
> `gcloud compute firewall-rules list` 로 확인 후 없을 때만 생성하세요.

### 4. Cloud NAT 설정 (외부 IP 없는 VM의 인터넷 아웃바운드)

외부 IP가 없는 VM(node, mysql, redis)은 `apt-get install` 등 인터넷 아웃바운드가 차단됩니다.

```bash
# Cloud Router 생성
gcloud compute routers create quizground-router \
  --network=quizground \
  --region=asia-northeast3

# Cloud NAT 게이트웨이 생성
gcloud compute routers nats create quizground-nat \
  --router=quizground-router \
  --region=asia-northeast3 \
  --auto-allocate-nat-external-ips \
  --nat-all-subnet-ip-ranges
```

### 5. SSH 키 생성 및 등록

```bash
# 키 생성
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/quizground_deploy

# GCP 프로젝트 공통 메타데이터에 공개키 등록 (모든 VM에 자동 적용)
gcloud compute project-info add-metadata \
  --metadata-from-file ssh-keys=<(echo "USERNAME:$(ssh-keygen -y -f ~/.ssh/quizground_deploy)")
```

`USERNAME`은 GCP 계정 이메일의 `@` 앞부분입니다.

### 6. GitHub Secrets 등록

GitHub 저장소 → Settings → Secrets and variables → Actions에서 아래 7개를 등록합니다.

| Secret 이름 | 값 | 설명 |
|-------------|-----|------|
| `GCE_PRIVATE_KEY` | `cat ~/.ssh/quizground_deploy` 출력 전체 | SSH 개인키 (`-----BEGIN OPENSSH PRIVATE KEY-----` 포함) |
| `GCE_USERNAME` | GCP 계정 이메일의 `@` 앞부분 | SSH 접속 유저명 |
| `GCE_HOST_NGINX` | nginx VM 외부 IP | bastion 겸 nginx 배포 대상 |
| `GCE_INTERNAL_IP_NODE1` | node-1 내부 IP (`10.10.x.x`) | quizground 네트워크 IP |
| `GCE_INTERNAL_IP_NODE2` | node-2 내부 IP (`10.10.x.x`) | quizground 네트워크 IP |
| `ENV` | 프로덕션 `.env` 파일 내용 전체 (`CORS_ORIGIN` 제외) | BE 환경변수 |
| `CORS_ORIGIN` | 허용할 origin 목록 (쉼표 구분) | WebSocket CORS 허용 origin 별도 주입 |

내부 IP 확인:
```bash
gcloud compute instances list
```

> **주의**: node VM이 여러 네트워크에 붙어있으면 내부 IP가 여러 개 나옵니다.  
> 반드시 `quizground` 네트워크의 IP (`10.10.x.x`)를 사용해야 합니다.

### 7. 프로덕션 .env 작성

`ENV` 시크릿에 등록할 내용:

```env
WAS_PORT=3000

DB_HOST=<mysql VM 내부 IP>
DB_PORT=3306
DB_USER=<mysql 유저>
DB_PASSWD=<mysql 비밀번호>
DB_NAME=quizground

REDIS_URL=redis://<redis VM 내부 IP>:6379

JWT_SECRET=<랜덤 문자열>   # openssl rand -base64 32
COOKIE_SECURE=true
```

> `DEV` 변수는 포함하지 마세요. 없으면 프로덕션 모드(TypeORM synchronize 비활성화)로 동작합니다.

`CORS_ORIGIN`은 `ENV`에 넣지 말고 GitHub Actions Secret의 별도 `CORS_ORIGIN` 키에 등록하세요. 값은 쉼표 구분 문자열입니다. 예: `https://quizground.site,https://admin.quizground.site`

### 8. mysql / redis VM 설정

각 VM에 직접 SSH 접속 후 설치합니다 (nginx를 통해 접속):

```bash
ssh -J USERNAME@NGINX_EXTERNAL_IP USERNAME@MYSQL_INTERNAL_IP
```

**mysql VM:**
```bash
sudo apt-get install -y mysql-server
sudo mysql -e "CREATE DATABASE quizground;"
sudo mysql -e "CREATE USER 'appuser'@'%' IDENTIFIED BY 'your_password';"
sudo mysql -e "GRANT ALL PRIVILEGES ON quizground.* TO 'appuser'@'%';"
# bind-address 설정
sudo sed -i 's/bind-address.*/bind-address = 0.0.0.0/' /etc/mysql/mysql.conf.d/mysqld.cnf
sudo systemctl restart mysql
```

**redis VM:**
```bash
sudo apt-get install -y redis-server
sudo sed -i 's/^bind 127.0.0.1/bind 0.0.0.0/' /etc/redis/redis.conf
sudo systemctl restart redis
```

---

## 배포 후 확인

### PM2 상태 확인 (node-1 또는 node-2)
```bash
pm2 list
pm2 logs quiz-ground-was
```

### nginx 상태 확인
```bash
sudo nginx -t
sudo systemctl status nginx
sudo tail -f /var/log/nginx/error.log
```

### 서버 디렉토리 구조 (배포 후)
```
~/quizground/
  current/              ← 현재 실행 중인 버전
    .env
    BE/
      dist/src/main.js  ← PM2 실행 진입점
      node_modules/
      ecosystem.config.js
    scripts/
  tobe/                 ← 다음 배포 대기 디렉토리 (평소 비어 있음)
```

---

## 배포 특성 및 주의사항

### Rolling 배포 (무중단)
- node-1 → node-2 순서로 순차 배포
- 각 노드에서 `pm2 reload`는 새 프로세스를 먼저 올린 뒤 기존 프로세스를 종료하므로 요청 손실 없음
- **주의**: 두 노드가 잠시 다른 버전을 실행함. API가 하위 호환되도록 설계해야 함

### Socket.IO Sticky Session
- nginx upstream에 `ip_hash` 설정으로 동일 클라이언트는 항상 같은 WAS로 라우팅
- 클라이언트 IP가 바뀌면(모바일 등) 세션이 다른 노드로 갈 수 있음
- Redis pub/sub으로 노드 간 상태 동기화가 되어 있으므로 치명적이지 않음

### 최초 배포 자동화
- `was-deploy.sh`: Node.js, PM2 미설치 시 자동 설치 후 진행
- `nginx-deploy.sh`: nginx 미설치 시 자동 설치 후 진행

### .env 경로
- NestJS ConfigModule이 `envFilePath: '../.env'`로 설정되어 있음
- BE 프로세스 cwd가 `~/quizground/current/BE/`이므로 `.env`는 `~/quizground/current/.env`에 위치
- be.tar.gz에 `.env`를 루트 경로로 포함시켜 이 구조를 유지

### 서버 재부팅 시
- `pm2 startup` + `pm2 save`로 등록되어 있어 재부팅 후 자동 복구됨
- nginx는 systemd에 의해 자동 시작됨
