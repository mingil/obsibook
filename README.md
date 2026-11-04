# 📖 ObsiBook — Obsidian Web E-Book Reader (100% Read-Only)

[![Python 3.12](https://img.shields.io/badge/Python-3.12-2563EB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110%2B-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Docker Hub](https://img.shields.io/badge/Docker%20Hub-kimmingil%2Fobsibook-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/kimmingil/obsibook)
[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Fmingil%2Fobsibook-0284C7?logo=github&logoColor=white)](https://github.com/mingil/obsibook)
[![License: MIT](https://img.shields.io/badge/License-MIT-16A34A.svg)](./LICENSE)

**ObsiBook**은 시놀로지 드라이브(Synology Drive), iCloud, Dropbox 등으로 동기화 중인 **옵시디언 볼트(Obsidian Vault)를 원본 훼손이나 실수로 인한 수정 걱정 없이(`100% Read-Only`)**, PC·태블릿(iPad/갤럭시탭)·스마트폰 등 **어느 기기에서나 리디북스/밀리의서재 같은 웹 전자책(Web E-Book) 형태로 편안하게 이어 읽을 수 있도록 개발된 오픈소스 Docker 웹 애플리케이션**입니다.

**ObsiBook** is a containerized, **100% Read-Only Web E-Book Reader** for Obsidian vaults. Mount any local or NAS-synced Obsidian folder (`:ro`) and enjoy cross-device reading position sync, paragraph/section bookmarks with personal memos, customizable e-book typography (Sepia, Light, Dark, E-Ink), scroll vs. paginated chapter modes, built-in TTS audiobook narration, and a **built-in 1-click Cloudflare Custom Domain & Remote Access Manager**—without ever modifying a single file in your vault.

---

## ✨ 왜 Perlite 대신 ObsiBook인가요? (Key Features)

기존 마크다운 뷰어(Perlite 등)는 단순 문서 열람기에 가까워 긴 문서를 여러 기기에서 이어 읽기 불편합니다. **ObsiBook**은 **'독서(Reading)'와 '활용(Prompt/Reference)'**에 최적화된 전용 전자책 기능들을 제공합니다:

1. **🔒 완벽한 원본 보호 (100% Read-Only 아키텍처)**
   - 옵시디언 볼트 폴더를 Docker 컨테이너 내부에 `:ro`(읽기 전용)로 마운트하며, 백엔드에 파일 수정/삭제 API가 아예 존재하지 않습니다.
   - 여러 기기에서 동시에 열람해도 **시놀로지 드라이브(Synology Drive) 동기화 충돌 파일이 절대 생기지 않습니다.**
2. **⏱️ 기기 간 읽은 위치 자동 기억 & 이어 읽기 (`Cross-Device Scroll Sync`)**
   - PC에서 문서를 **42%**까지 읽고 닫은 뒤, 침대에서 아이패드나 스마트폰으로 접속하면 **마지막에 읽던 문서와 정확한 스크롤 위치(42% · 해당 소제목 챕터)**에서 즉시 이어 읽을 수 있습니다.
   - 모든 독서 진행률과 완독(`✓`) 기록은 볼트 외부의 독립된 경량 `SQLite` 데이터베이스(`/app/data`)에 안전하게 저장됩니다.
3. **🔖 다중 책갈피 & 개인 독서 메모 (`Bookmarks & Section Memos`)**
   - 문서를 읽다가 상단 **[🔖 책갈피]** 버튼(단축키 `B`) 또는 각 소제목 옆의 핀 버튼을 눌러 **현재 위치(%)와 개인 독서 메모, 색상 태그**를 남길 수 있습니다. (원본 `.md` 파일은 건드리지 않음)
4. **🎨 전자책 전용 뷰어 맞춤 설정 (`E-Book Typography & 4 Themes`)**
   - **4가지 독서 테마:** ☀️ **종이책(Sepia)**, 🤍 **화이트(Light)**, 🌙 **다크(Dark)**, ✒️ **이잉크(E-Ink 전자책 단말기용 고대비)**
   - **글꼴/크기/줄간격/여백 조절:** 전자책 본문용 명조(`Noto Serif KR`) / 고딕(`Pretendard`) / 고정폭 선택, 글자 크기(`14~26px`), 줄간격(`1.4~2.3`), 본문 폭 조절 및 **집중 독서 모드(Zen Mode, 단축키 `F`)** 지원
5. **📜 연속 스크롤 모드 ↔ 📖 챕터 페이지 넘김 모드 & 🎧 오디오북(TTS) 낭독**
   - 취향에 따라 일반 웹처럼 스크롤하며 읽거나, 챕터별 페이지 넘김 버튼(키보드 `←` / `→`)으로 넘겨 읽을 수 있습니다.
   - **[🎧 낭독]** 버튼을 누르면 현재 문서를 문단별로 하이라이트하며 음성 오디오북처럼 읽어줍니다.
6. **🌐 웹 UI 내장형 Cloudflare 도메인 & 외부 접속 센터 (`Built-in Tunnel Manager`)**
   - 별도의 `cloudflared` 컨테이너를 띄우거나 공유기 포트포워딩(`80/443`)을 할 필요 없이, 웹 화면 우측 상단 **[🌐 도메인/외부접속]** 버튼에서 **1) 내 Cloudflare 도메인(예: `obsidian.yourdomain.com`) 원클릭 로그인 자동 DNS 개통**, **2) Zero Trust 터널 토큰 연결**, **3) 1초 임시 외부 접속 주소(`*.trycloudflare.com`) 생성**, **4) 서재 열람 비밀번호 잠금**을 모두 클릭만으로 설정할 수 있습니다.
7. **🧩 옵시디언 문법 완벽 호환 & 📋 프롬프트 원클릭 복사**
   - `YAML Frontmatter` 상단 메타데이터 카드화, `[[위키링크]]` 문서 간 이동, `![[이미지]]` 렌더링, `> [!NOTE]` / `> [!TIP]` 콜아웃 박스, `#태그` 필터, `Mermaid` 다이어그램, 반응형 표, **코드/프롬프트 블록 1-Click 복사 버튼**을 기본 내장했습니다.

---

## 🐳 1분 만에 시작하기 (Quick Start with Docker)

누구나 본인의 옵시디언 볼트 경로(`OBSIDIAN_VAULT_PATH`)만 지정하면 즉시 사용할 수 있습니다.

### 방법 A. 시놀로지 NAS (Synology Drive 옵시디언 사용자 권장)

Windows PC에서 `Y:\home\SynologyDrive\Obsidian` (하위에 `AI_Command_Prompts`, `Dr_Rehab_Master`, `NotebookLM_Macro`, `AI_Prompts` 등이 있는 폴더)로 사용 중이시라면, 시놀로지 NAS 내부에서의 실제 리눅스 경로는 아래와 같습니다:
- **`/volume1/homes/시놀로지계정ID/SynologyDrive/Obsidian`** *(또는 `/volume1/homes/시놀로지계정ID/Drive/Obsidian`)*
- *팁: 시놀로지 **File Station**에서 `Obsidian` 폴더 우클릭 ➔ **[속성(Properties)]**을 누르면 정확한 **`위치(Location)`** 경로를 복사할 수 있습니다.*

#### 1. `.env` 파일 설정
```bash
cp .env.example .env
```
`.env` 파일에서 `OBSIDIAN_VAULT_PATH`에 본인의 옵시디언 볼트 경로를 입력합니다:
```env
OBSIDIAN_VAULT_PATH=/volume1/homes/본인ID/SynologyDrive/Obsidian
DATA_HOST_PATH=/volume1/docker/obsibook/data
APP_PORT=18505
VAULT_TITLE="내 옵시디언 전자책 서재"
APP_PASSWORD=""
```

#### 2. 컨테이너 실행
```bash
docker compose up -d --build
```
이제 브라우저에서 **`http://시놀로지IP:18505`** 로 접속하면 모든 옵시디언 폴더와 문서가 전자책 서재로 열립니다!

---

### 방법 B. 시놀로지 Container Manager GUI에서 이미지 검색으로 설치하기

코드를 복제할 필요 없이 시놀로지 **Container Manager**의 **[레지스트리(Registry)]** 탭에서 **`kimmingil/obsibook`**을 검색하여 다운로드한 뒤, 아래 2개의 볼륨 폴더만 연결해 주면 됩니다:

| 호스트 경로 (시놀로지 폴더) | 컨테이너 내부 경로 | 권한 설정 | 역할 |
| :--- | :--- | :---: | :--- |
| `/home/SynologyDrive/Obsidian` | **`/vault`** | **읽기 전용 (Read-Only) 체크 필수** | 원본 옵시디언 볼트 폴더 |
| `/docker/obsibook/data` | **`/app/data`** | 읽기/쓰기 (Read/Write) | 읽은 위치·책갈피·도메인설정 저장 폴더 |

- **포트 설정:** 로컬 포트 `18505` (원하는 포트) ➔ 컨테이너 포트 `8500`

---

### 방법 C. 단일 `docker run` 명령어로 실행하기 (Linux / macOS / Windows)

```bash
docker run -d \
  --name obsibook_reader \
  -p 18505:8500 \
  -v "/path/to/your/ObsidianVault:/vault:ro" \
  -v "/path/to/save/obsibook_data:/app/data" \
  -e VAULT_TITLE="My Obsidian E-Book" \
  -e APP_PASSWORD="" \
  --restart unless-stopped \
  kimmingil/obsibook:latest
```

---

## 🌐 웹 화면 안에서 내 도메인(Cloudflare) 원클릭 연결하기

ObsiBook 도커 이미지에는 공식 `cloudflared`가 기본 내장되어 있어, 웹 화면 우측 상단의 **[🌐 도메인/외부접속]** 버튼만 누르면 아래 두 가지 방법 중 원하는 방식으로 즉시 외부 HTTPS 접속을 열 수 있습니다:

1. **🔑 방법 1 (가장 쉬움 — Cloudflare 로그인 자동 개통):**
   - 연결할 서브도메인(예: `obsidian.yourdomain.com`)을 입력하고 **[🔑 Cloudflare 인증 링크 생성]** 클릭
   - 생성된 링크를 눌러 Cloudflare에서 내 도메인을 선택해 **[Authorize]**를 누르면, 터널 생성 + DNS(CNAME) 자동 등록 + 영구 실행이 자동으로 완료됩니다.
2. **🎫 방법 2 (Cloudflare Zero Trust 터널 토큰 입력):**
   - Cloudflare Zero Trust 대시보드에서 발급한 터널 토큰(`eyJhIjoi...`)을 붙여넣고 **[🎫 토큰으로 연결]**을 누르면 즉시 영구 연결됩니다.

---

## ⌨️ 편리한 단축키 안내 (Keyboard Shortcuts)

- **`F`**: 집중 독서 모드 (양쪽 사이드바 숨기기 / 다시 보이기)
- **`B`**: 현재 읽고 있는 스크롤 위치에 책갈피 & 독서 메모 추가
- **`←` / `→`**: (챕터 넘김 모드일 때) 이전 챕터 / 다음 챕터 이동

---

## 🗂️ 프로젝트 구조 (Project Structure)

```text
obsidian_ebook_reader/
├── app.py                         # FastAPI 백엔드 서버 & REST API 엔드포인트
├── modules/
│   ├── config.py                  # 환경 변수 및 볼트/데이터 경로 설정
│   ├── db_manager.py              # 기기 간 독서 위치·완독·책갈피·뷰어설정 SQLite 엔진
│   ├── vault_scanner.py           # 100% Read-Only 옵시디언 마크다운·위키링크·콜아웃 파서
│   └── tunnel_manager.py          # 웹 내장형 Cloudflare 도메인 자동 개통 & 터널 데몬 매니저
├── static/
│   ├── index.html                 # 반응형 웹 이북 리더 UI (서재 홈, 뷰어, 도메인/보안 모달)
│   ├── styles.css                 # 4대 전자책 테마(종이책/화이트/다크/이잉크) & 타이포그래피
│   ├── app.js                     # 실시간 스크롤 동기화, 목차 스파이, 오디오북(TTS), 프롬프트 복사
│   └── manifest.json              # 모바일 홈 화면 추가(PWA) 지원 매니페스트
├── sample_vault/                  # 즉시 테스트 가능한 샘플 옵시디언 볼트 (4대 폴더 구성)
├── tests/
│   └── test_obsibook.py           # 읽기 전용 무결성, 경로 보안, DB 동기화, 터널 매니저 단위 테스트
├── Dockerfile                     # Python 3.12-slim + 공식 cloudflared 내장 컨테이너 빌드 명세
├── compose.yaml                   # 표준 Docker Compose 설정 (:ro 볼트 마운트)
├── compose.cloudflare.yaml        # 외부 cloudflared 컨테이너 분리형 선택 배포 설정
├── .env.example                   # 사용자 맞춤 환경 변수 템플릿
└── LICENSE                        # MIT 오픈소스 라이선스
```

---

## 🧪 단위 테스트 실행 (Running Tests)

```bash
python3 -m pytest tests/test_obsibook.py -v
```

---

## 📄 라이선스 (License)
이 프로젝트는 [MIT License](./LICENSE)로 배포되는 오픈소스 소프트웨어입니다. 누구나 자유롭게 본인의 옵시디언 환경에 맞게 활용하고 배포할 수 있습니다.
