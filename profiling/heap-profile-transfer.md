# Heap Profile 로컬 전송 가이드

GCP private subnet(node1/node2) → 로컬로 heap profile 가져오는 절차.
PEM 키 없이 GCP 콘솔 브라우저 SSH만으로 가능.

---

## 인프라 구조

```
로컬
  ↕ (브라우저 SSH 다운로드)
quizground-nginx  34.158.197.135 / 10.10.10.3   ← 외부 IP 있음 (bastion)
  ↕ (내부망)
quizground-node1  10.10.20.10                   ← 외부 IP 없음
quizground-node2  10.10.20.9                    ← 외부 IP 없음
```

---

## 전송 절차

### 1단계 — node1에서 임시 HTTP 서버 실행

GCP 콘솔 → quizground-node1 SSH 접속:

```bash
cd ~/heap-profiles
python3 -m http.server 8888
```

### 2단계 — nginx에서 파일 다운로드

GCP 콘솔 → quizground-nginx SSH 접속:

```bash
# 파일 목록 확인
curl http://10.10.20.10:8888/

# 파일 받기 (파일명은 위에서 확인한 것으로 교체)
curl http://10.10.20.10:8888/Heap.YYYYMMDD.HHMMSS.xxxxx.0.001.heapprofile \
  -o /tmp/Heap.YYYYMMDD.HHMMSS.xxxxx.0.001.heapprofile
```

> curl 명령은 반드시 한 줄로 실행. 줄바꿈 시 `-o` 가 별도 명령으로 인식되어 실패함.

### 3단계 — 로컬로 다운로드

브라우저 SSH 우측 상단 **톱니바퀴(⚙) → Download file** 클릭 →
`/tmp/파일명.heapprofile` 입력 → 다운로드

### 4단계 — HTTP 서버 종료

node1 SSH 터미널에서 `Ctrl+C`

---

## node2인 경우

2단계의 IP만 변경:

```bash
curl http://10.10.20.9:8888/파일명.heapprofile -o /tmp/파일명.heapprofile
```

---

## 분석 방법 — Chrome DevTools

`.heapprofile`은 V8 샘플링 힙 프로파일러 형식. **어느 함수에서 메모리를 얼마나 할당하는지** 보여줌.

### 열기

1. Chrome 주소창에 `chrome://inspect` 입력
2. **Memory** 탭 클릭
3. 좌측 하단 **Load** 버튼 → `.heapprofile` 파일 선택

### 뷰 종류

| 뷰 | 용도 |
|----|------|
| Chart | 시간축 할당 흐름 |
| Heavy (Bottom Up) | **할당량 많은 함수 순위** ← 주로 이걸 봄 |
| Tree (Top Down) | 콜스택 top-down 탐색 |

**Heavy 뷰에서 Self Size 기준 정렬**이 기본 시작점.

### 무엇을 봐야 하나

CPU 프로파일 분석(`analysis.md`)에서 GC 압박이 주요 병목으로 확인됨.
heap profile에서 확인할 포인트:

- **Self Size 상위 함수** → 단수명(short-lived) 객체를 대량 생성하는 위치
- `Buffer.from`, `encodeAsString`, `writeUtf8String` 계열이 상위에 있는지
- `socket.io` 내부 vs 직접 작성한 코드(`game-*.js`) 비율


