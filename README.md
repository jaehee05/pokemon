# 포켓몬 카드 인벤토리

스프레드시트로 손수 관리하던 포켓몬 카드 재고를 단일 페이지에서 관리하는 웹앱입니다. 일련번호·카드명·등급·가치·보유 수량을 한 테이블에 통합해 빠르게 추가/수정/삭제하고, 총 가치를 실시간으로 확인합니다.

- 빌드 단계 없음 (HTML / CSS / ES module JS만 사용)
- Firebase Anonymous Auth로 자동 로그인 → 브라우저별 안전한 데이터 격리
- Firestore 실시간 동기화 + 오프라인 지속 캐시(IndexedDB)
- 기존 catalog/collection 데이터 또는 localStorage 데이터가 있으면 자동으로 단일 인벤토리로 마이그레이션됩니다

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
2. **Authentication → Sign-in method**에서 **Anonymous** 제공업체를 활성화합니다.
3. **Firestore Database**를 **Native 모드**로 생성합니다 (지역은 가까운 곳, 예: `asia-northeast3`).
4. **Firestore → Rules** 탭에 `firestore.rules`의 내용을 그대로 붙여넣고 **게시**합니다.
5. **Project Settings → 일반 → 승인된 도메인**에 다음을 추가합니다.
   - `localhost`
   - 배포된 Vercel 도메인 (예: `your-app.vercel.app`)

> ⚠️ 익명 인증을 활성화하지 않으면 페이지 우측 상단 동기화 배지가 "오류"로 표시됩니다.

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
/users/{uid}/data/inventory
  -> { items: { [key]: { no, name, grade, value, qty } }, updatedAt }
```

- `key`는 일련번호를 정규화한 값 (`SV10-032`, `sv10 032`, `sv10_032` → `sv10-032`).
- 단일 문서로 관리되어 한 번의 읽기/쓰기로 전체 상태를 동기화합니다.

## 마이그레이션

이전 버전(`catalog` + `collection` 분리 모델)을 사용했던 사용자는 처음 접속 시 자동으로 단일 인벤토리로 합쳐집니다.

- 기존 `catalog` 항목은 가치·이름이 채워진 상태(수량 0)로 가져옵니다.
- 기존 `collection` 항목은 동일 키 위에 수량을 덮어씁니다.
- 양쪽 모두 정보가 비어 있는 항목(이름/가치/수량 없음)은 자동으로 정리됩니다.

## 주의

- 익명 인증의 UID는 브라우저(IndexedDB)에 저장됩니다. 시크릿 모드, 데이터 삭제, 다른 기기에서는 다른 UID가 발급되어 데이터가 분리됩니다.
- Firebase 웹 API 키는 공개되어도 안전합니다. 데이터 보호는 위의 보안 규칙으로 이루어집니다.
