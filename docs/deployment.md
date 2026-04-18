# QuizGround 배포 가이드 (GCE 분산 환경)

## 아키텍처

```
인터넷
  │
  ▼
nginx VM (:80)          ← FE 정적 파일 서빙 + BE 리버스 프록시
  │  ip_hash upstream
  ├──▶ node-1 VM (:3000)  ← NestJS WAS (quiz-ground-was)
  └──▶ node-2 VM (:3000)  ← NestJS WAS (quiz-ground-was)
            │
     내부 네트워크
            ├──▶ mysql VM (:3306)
            └──▶ redis VM (:6379)
```

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
    └─ node-1에 be.tar.gz 전송 → was-deploy.sh 실행 → PM2 reload
    │
    ▼  (node-1 완료 후 시작 → rolling deploy)
[3] deploy-node2 job
    └─ node-2에 be.tar.gz 전송 → was-deploy.sh 실행 → PM2 reload
    │
    ▼
[4] deploy-nginx job
    └─ nginx에 fe.tar.gz 전송 → nginx-deploy.sh 실행 → nginx reload
```

**Rolling 배포**: node-1 배포 중 node-2가 트래픽 처리 → node-2 배포 중 node-1이 처리.  
무중단 배포가 보장됩니다.

---

## 최초 배포 전 설정

### 1. GCE VM 생성 (5대)

| VM 이름 | 역할 | 권장 사양 | 허용 포트 |
|---------|------|-----------|-----------|
| quizground-nginx | 리버스 프록시 + FE | e2-micro (1vCPU, 1GB) | 80, 443 (외부) |
| quizground-node1 | NestJS WAS | e2-small (2vCPU, 2GB) | 3000 (내부망만) |
| quizground-node2 | NestJS WAS | e2-small (2vCPU, 2GB) | 3000 (내부망만) |
| quizground-mysql | MySQL 8.0 | e2-small (2vCPU, 2GB) | 3306 (내부망만) |
| quizground-redis | Redis | e2-micro (1vCPU, 1GB) | 6379 (내부망만) |

> **보안**: node, mysql, redis VM은 외부 IP 없이 내부망만 사용 권장.  
> nginx만 외부 트래픽 수신.

### 2. GCE 방화벽 규칙

```bash
# nginx: 외부에서 80 허용
gcloud compute firewall-rules create allow-http \
  --allow tcp:80 \
  --target-tags quizground-nginx

# WAS: 내부망에서만 3000 허용
gcloud compute firewall-rules create allow-was-internal \
  --allow tcp:3000 \
  --source-ranges 10.0.0.0/8 \
  --target-tags quizground-was

# MySQL: 내부망에서만 3306 허용
gcloud compute firewall-rules create allow-mysql-internal \
  --allow tcp:3306 \
  --source-ranges 10.0.0.0/8 \
  --target-tags quizground-mysql

# Redis: 내부망에서만 6379 허용
gcloud compute firewall-rules create allow-redis-internal \
  --allow tcp:6379 \
  --source-ranges 10.0.0.0/8 \
  --target-tags quizground-redis
```

여기까지 완료 !! 

### 3. Cloud NAT 설정 (외부 IP 없는 VM의 인터넷 아웃바운드)

외부 IP가 없는 VM(node, mysql, redis)은 `apt-get install` 등 인터넷 아웃바운드가 차단됩니다.  
Cloud NAT를 설정하면 외부 IP 없이도 아웃바운드 통신이 가능해집니다.

```bash
# 1. Cloud Router 생성 (VPC/리전은 VM과 동일하게)
gcloud compute routers create quizground-router \
  --network default \
  --region asia-northeast3

# 2. Cloud NAT 게이트웨이 생성
gcloud compute routers nats create quizground-nat \
  --router quizground-router \
  --region asia-northeast3 \
  --auto-allocate-nat-external-ips \
  --nat-all-subnet-ip-ranges
```

> `--network`와 `--region`은 VM 생성 시 선택한 값과 맞춰야 합니다.  
> 설정 후 수 분 내에 적용되며, 이후 `apt-get install` 정상 동작합니다.

### 4. SSH 키 생성 및 등록

GitHub Actions에서 모든 VM에 SSH 접속하기 위한 키 쌍을 생성합니다.

```bash
# 로컬에서 키 생성
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/quizground_deploy

# 공개키 내용 확인 (GCE 메타데이터에 등록할 내용)
cat ~/.ssh/quizground_deploy.pub
```

각 VM의 `메타데이터 > SSH 키`에 위 공개키를 추가하거나, GCP 프로젝트 공통 메타데이터에 추가합니다.

### 5. GitHub Secrets 등록

GitHub 저장소 → Settings → Secrets and variables → Actions에서 아래 6개를 등록합니다.

| Secret 이름 | 값 | 설명 |
|-------------|-----|------|
| `GCE_PRIVATE_KEY` | `cat ~/.ssh/quizground_deploy` 출력 내용 | SSH 개인키 (-----BEGIN OPENSSH PRIVATE KEY----- 포함) |
| `GCE_USERNAME` | VM 유저명 (GCP 계정 이메일 @ 앞부분) | SSH 접속 유저 |
| `GCE_HOST_NGINX` | `34.xxx.xxx.xxx` | nginx VM **외부** IP (bastion 역할) |
| `GCE_INTERNAL_IP_NODE1` | `10.xxx.xxx.xxx` | node-1 **내부** IP |
| `GCE_INTERNAL_IP_NODE2` | `10.xxx.xxx.xxx` | node-2 **내부** IP |
| `ENV` | `.env` 파일 내용 전체 | 프로덕션 환경변수 |

> **node VM 접속 방식**: node-1/2는 외부 IP가 없으므로 `GCE_HOST_NGINX`를 ProxyJump(bastion)로 경유합니다.  
> CI/CD 워크플로우가 자동으로 nginx → node 내부망 SSH 터널을 설정합니다.

### 6. 프로덕션 .env 작성

`ENV` 시크릿에 등록할 내용 예시:

```env
# 서버
WAS_PORT=3000

# MySQL
DB_HOST=<mysql VM 내부 IP>
DB_PORT=3306
DB_USER=<mysql 유저>
DB_PASSWD=<mysql 비밀번호>
DB_NAME=quizground

# Redis
REDIS_URL=redis://<redis VM 내부 IP>:6379

# 인증
JWT_SECRET=<강력한 랜덤 문자열>   # openssl rand -base64 32 로 생성 권장
COOKIE_SECURE=true
```

> `DEV` 변수는 포함하지 마세요. 없으면 프로덕션 모드(TypeORM synchronize 비활성화)로 동작합니다.

### 7. mysql / redis VM 설정

mysql과 redis는 코드 배포 대상이 아니므로, 각 VM에 직접 접속하여 설치합니다.

**mysql VM:**
```bash
sudo apt-get install -y mysql-server
sudo mysql -e "CREATE DATABASE quizground;"
sudo mysql -e "CREATE USER 'appuser'@'%' IDENTIFIED BY 'your_password';"
sudo mysql -e "GRANT ALL PRIVILEGES ON quizground.* TO 'appuser'@'%';"
# /etc/mysql/mysql.conf.d/mysqld.cnf 에서 bind-address = 0.0.0.0 설정
sudo systemctl restart mysql
```

**redis VM:**
```bash
sudo apt-get install -y redis-server
# /etc/redis/redis.conf 에서 bind 0.0.0.0 설정 (내부망이므로 안전)
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
    FE/
      dist/             ← nginx가 /var/www/html/로 복사
    scripts/
  tobe/                 ← 다음 배포 대기 디렉토리 (평소 비어 있음)
```

---

## 배포 특성 및 주의사항

### Rolling 배포 (무중단)
- node-1 → node-2 순서로 순차 배포
- 각 노드에서 `pm2 reload`는 새 프로세스를 먼저 올린 뒤 기존 프로세스를 종료하므로 요청 손실 없음
- **주의**: 두 노드가 서로 다른 버전을 잠시 실행하는 구간이 있음. API가 하위 호환되도록 설계해야 함

### Socket.IO Sticky Session
- nginx upstream에 `ip_hash` 설정으로 동일 클라이언트는 항상 같은 WAS로 라우팅
- 클라이언트 IP가 바뀌면(모바일 등) 세션이 다른 노드로 갈 수 있음
- Redis pub/sub으로 노드 간 상태 동기화가 되어 있으므로 치명적이지 않음

### 최초 배포 자동화
- `was-deploy.sh`: Node.js, PM2 미설치 시 자동 설치 후 진행
- `nginx-deploy.sh`: nginx 미설치 시 자동 설치 후 진행
- 이후 재배포부터는 설치 단계를 건너뛰고 바로 배포

### .env 경로
- NestJS ConfigModule이 `envFilePath: '../.env'`로 설정되어 있음
- BE 프로세스 cwd가 `~/quizground/current/BE/`이므로 `.env`는 `~/quizground/current/.env`에 위치
- be.tar.gz에 `.env`를 루트 경로로 포함시켜 이 구조를 유지

### 서버 재부팅 시
- `pm2 startup` + `pm2 save`로 등록되어 있어 재부팅 후 자동 복구됨
- nginx는 systemd에 의해 자동 시작됨
