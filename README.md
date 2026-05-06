# 포켓몬 카드 인벤토리

스프레드시트로 손수 관리하던 포켓몬 카드 재고를 단일 페이지에서 관리하는 웹앱입니다. 일련번호·카드명·등급·가치·보유 수량을 한 테이블에 통합해 빠르게 추가/수정/삭제하고, 총 가치를 실시간으로 확인합니다.

- **카드 사진 OCR**: Tesseract.js로 일련번호 자동 추출 → 마스터 카탈로그 매칭으로 이름/등급/가치 자동 채움 + 동일 사진을 카드 이미지로 함께 업로드
- **마스터 카탈로그**: 관리자가 카드를 추가/수정할 때마다 `/public/catalog`에 자동 누적. 다음에 같은 일련번호를 OCR로 인식하면 자동 채움
- 빌드 단계 없음 (HTML / CSS / ES module JS만 사용)
- **공개 읽기 / 관리자 쓰기**: 누구나 인벤토리 카드 목록을 볼 수 있고, 관리자(화이트리스트 이메일)만 추가/수정/삭제 가능
- Google 로그인 (팝업) — 관리자만 편집 UI 활성화
- Firestore 실시간 동기화 + 오프라인 지속 캐시(IndexedDB)
- **카드별 사진 업로드** (Firebase Storage) + 클릭 시 라이트박스 확대
- 클라이언트 측 이미지 리사이즈 (가로/세로 최대 900px, JPEG 0.85)로 저장 비용 최소화
- 기존 데이터(`/users/{uid}/data/inventory`, `catalog/collection`, localStorage)는 첫 관리자 로그인 시 자동으로 `/public/inventory`로 이전됩니다

## 주요 기능

- **단일 인벤토리 테이블**: 일련번호 / 카드명 / 등급 / 가치 / 보유 수량 / 합계
- **인라인 편집**: 카드명 클릭 편집, 등급 드롭다운, 가치/수량 즉시 수정, ＋/－/× 버튼
- **등급 배지** (RR / R / U / AR / SR / SAR / UR / C 등) — 스프레드시트와 동일한 색상
- **통계 대시보드**: 총 종류, 총 보유 매수, 총 가치 + 등급별 종류·매수
- **정렬 가능한 컬럼**: 컬럼 헤더 클릭으로 일련번호/카드명/등급/가치/수량/합계 정렬
- **등급 필터 칩 + 검색**: 등급별 빠른 보기 + 일련번호/카드명 검색
- **CSV 가져오기/내보내기**: 5열(`일련번호 / 카드명 / 등급 / 가치 / 보유 수량`) 포맷, 헤더 자동 인식
- **자동완성 + 중복 합산**: 동일 일련번호 추가 시 수량 자동 합산

## 파일 구성

| 파일 | 설명 |
|------|------|
| `index.html` | UI 마크업 |
| `styles.css` | 스타일 (등급 배지, 통계, 정렬 헤더, 필터 칩) |
| `firebase.js` | Firebase 초기화 (App / Firestore / Auth) |
| `app.js` | 앱 로직 (CSV 파싱, 인벤토리 CRUD, 통계, 마이그레이션) |
| `firestore.rules` | Firestore 보안 규칙 (콘솔에 적용) |
| `vercel.json` | Vercel 배포 설정 |

## Firebase 설정 (필수)

1. [Firebase 콘솔](https://console.firebase.google.com/) → `pokemon-1eacb` 프로젝트 선택.
2. **Authentication → Sign-in method**에서 **Google** 제공업체를 활성화합니다.
3. **Firestore Database**를 **Native 모드**로 생성합니다 (지역은 가까운 곳, 예: `asia-northeast3`).
4. **Firestore → Rules** 탭에 `firestore.rules`의 내용을 그대로 붙여넣고 **게시**합니다.
5. **Storage** 메뉴에서 기본 버킷을 활성화합니다.
   - 카드 이미지 저장에 사용됩니다.
   - 신규 프로젝트는 Blaze(종량) 요금제로 업그레이드가 필요할 수 있습니다 (사용량 무료 한도 내라면 비용 0원).
6. **Storage → Rules** 탭에 `storage.rules`의 내용을 그대로 붙여넣고 **게시**합니다.
7. **Authentication → Settings → 승인된 도메인**에 다음을 추가합니다.
   - `localhost`
   - 배포된 Vercel 도메인 (예: `your-app.vercel.app`)

### 관리자 이메일 등록 (중요)

관리자만 인벤토리를 수정할 수 있도록, 다음 **세 곳**에 본인의 Google 이메일을 동일하게 추가하세요.

1. **`firebase.js`**
   ```js
   export const OWNER_EMAILS = [
     "your-email@gmail.com",
   ];
   ```
2. **`firestore.rules`** 의 `isOwner()` 함수 → Firestore Rules 콘솔 게시
3. **`storage.rules`** 의 화이트리스트 → Storage Rules 콘솔 게시

> 셋 중 하나라도 비어 있으면 동작이 어긋납니다. 클라이언트에서는 관리자처럼 보여도 서버 쓰기/이미지 업로드가 거부됩니다.

### 동작 모드

| 상태 | 보이는 화면 |
|------|-------------|
| 비로그인 방문자 | 카드 리스트(검색·필터·정렬·CSV 내보내기까지)만 표시 |
| 로그인 + 화이트리스트 외 계정 | "읽기 전용" 배지, 편집 UI 숨김 |
| 로그인 + 관리자 계정 | "관리자" 배지, 추가/수정/삭제/임포트 모두 활성화 |

## 로컬 실행

이 프로젝트는 빌드가 필요 없지만, ES module을 사용하므로 `file://`로 열면 동작하지 않습니다.

```bash
# Python
python3 -m http.server 5173

# 또는 Node
npx serve .
```

이후 `http://localhost:5173`을 엽니다.

## Vercel 배포

### 옵션 A: GitHub 연동 (권장)

1. GitHub에 레포를 푸시합니다.
2. [Vercel](https://vercel.com/) → **Add New → Project**에서 이 레포를 가져옵니다.
3. Framework Preset은 **Other**, Build Command와 Output Directory는 비워둡니다.
4. **Deploy**를 누르고, 배포된 도메인을 Firebase의 승인된 도메인에 추가합니다.

### 옵션 B: CLI

```bash
npm i -g vercel
vercel
vercel --prod
```

## 사용법

1. **카드 추가** 폼에 일련번호를 입력합니다 (자동완성 제안). 카드명·등급·가치·수량은 선택 입력이며, 같은 일련번호로 다시 추가하면 수량이 합산됩니다.
2. **인벤토리 테이블**에서 셀을 클릭/포커스해 바로 수정합니다.
   - 카드명: 클릭하면 편집 가능, Enter로 저장 / Esc로 취소
   - 등급: 드롭다운 선택
   - 가치 / 수량: 숫자 입력, ＋/－ 버튼 또는 직접 수정
   - 수량을 0으로 만들면 자동 삭제됩니다
3. **CSV 가져오기**로 스프레드시트를 일괄 등록하거나 **붙여넣기**로 직접 입력합니다.
4. **CSV 내보내기**로 백업을 받습니다.

### CSV 포맷 예시

```
일련번호	카드명	등급	가치	보유 수량
sv10-032	우락고래ex	RR	2000	1
sv10-088	로켓단의 리시버	U	2000	2
sv11W-092	바라철록	AR	5000	1
```

탭 또는 콤마로 구분되며, 헤더는 자동 인식됩니다.

## 데이터 모델

Firestore 경로:

```
/public/inventory
  -> { items: { [key]: { no, name, grade, value, qty } }, updatedAt, updatedBy }
```

- `key`는 일련번호를 정규화한 값 (`SV10-032`, `sv10 032`, `sv10_032` → `sv10-032`).
- 단일 문서로 관리되어 한 번의 읽기/쓰기로 전체 상태를 동기화합니다.
- 누구나 읽을 수 있고, 관리자만 쓸 수 있습니다 (보안 규칙).

## OCR + 마스터 카탈로그

### 동작 흐름
1. 관리자 모드에서 "카드 추가/수정" 패널의 **📷 사진으로 일련번호 인식** 버튼 클릭
2. 카드 사진 선택 → Tesseract.js (브라우저)에서 OCR 수행 (최초 1회만 모델 다운로드 ~5MB)
3. 추출된 일련번호 (예: `sv10-032`)를 **마스터 카탈로그**에서 조회
4. 일치하는 항목이 있으면 **카드명·등급·가치 자동 입력**
5. 폼 검토 후 "추가" 클릭 → 카드 등록 + 인식했던 사진을 카드 이미지로 업로드

### 카탈로그는 어떻게 채워지나
- 관리자가 카드를 등록할 때마다 `/public/catalog` 에 자동 누적
- CSV 가져오기로 일괄 임포트하면 한 번에 카탈로그 채워짐
- 별도 카탈로그 관리 UI는 없음 (인벤토리 자체가 마스터)

### 포켓몬코리아 크롤러 (선택)
한 번에 카드 데이터를 채우고 싶다면 `scripts/scrape-pokemon-korea.mjs` 를 로컬에서 실행:

```bash
# 전체
node scripts/scrape-pokemon-korea.mjs > catalog.csv
# 특정 확장팩
node scripts/scrape-pokemon-korea.mjs sv10 > sv10.csv
```

생성된 CSV를 사이트의 **CSV 가져오기** 버튼으로 임포트하면 카탈로그가 채워집니다.

> ⚠️ 사이트 구조가 바뀌면 스크립트 상단의 `SELECTORS` 정규식을 수정해야 합니다. JS 렌더링 페이지인 경우 `playwright`/`puppeteer` 등 헤드리스 브라우저가 필요할 수 있습니다.

## 마이그레이션

이전 버전 데이터는 처음 관리자 로그인 시 자동으로 `/public/inventory` 로 합쳐집니다.

1. `/users/{uid}/data/inventory` (사용자별 인벤토리) → 그대로 복사
2. `/users/{uid}/data/catalog` + `collection` (구버전) → 키 단위로 합쳐서 가져오기
3. 위 둘 다 없으면 localStorage 의 `pokemon_catalog_v1` / `pokemon_collection_v1` 사용

## 주의

- 관리자 계정이 추가/제거된 직후에는 브라우저를 새로고침하세요. 토큰이 갱신되어야 새 권한이 반영됩니다.
- Firebase 웹 API 키는 공개되어도 안전합니다. 데이터 보호는 위의 보안 규칙으로 이루어집니다.
