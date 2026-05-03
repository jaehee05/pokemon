# 포켓몬 카드 가격 계산기

Firebase Firestore에 가격표와 보유 목록을 저장하고, Vercel에서 정적으로 호스팅하는 단일 페이지 웹앱입니다.

- 빌드 단계 없음 (HTML / CSS / ES module JS만 사용)
- Firebase Anonymous Auth로 자동 로그인 → 브라우저별 안전한 데이터 격리
- Firestore 실시간 동기화 + 오프라인 지속 캐시(IndexedDB)
- localStorage에 남아 있던 이전 데이터는 첫 로그인 시 자동으로 Firestore로 이전됩니다

## 파일 구성

| 파일 | 설명 |
|------|------|
| `index.html` | UI 마크업 |
| `styles.css` | 스타일 |
| `firebase.js` | Firebase 초기화 (App / Firestore / Auth) |
| `app.js` | 앱 로직 (CSV 파싱, 카탈로그/보유 목록, 동기화) |
| `firestore.rules` | Firestore 보안 규칙 (콘솔에 적용) |
| `vercel.json` | Vercel 배포 설정 |

## Firebase 설정 (필수)

1. [Firebase 콘솔](https://console.firebase.google.com/) → `pokemon-1eacb` 프로젝트 선택.
2. **Authentication → Sign-in method**에서 **Anonymous** 제공업체를 활성화합니다.
3. **Firestore Database**를 **Native 모드**로 생성합니다 (지역은 가까운 곳, 예: `asia-northeast3`).
4. **Firestore → Rules** 탭에 `firestore.rules`의 내용을 그대로 붙여넣고 **게시**합니다.
5. **Project Settings → 일반 → 승인된 도메인**에 다음을 추가합니다.
   - `localhost`
   - 배포된 Vercel 도메인 (예: `your-app.vercel.app`, 그리고 커스텀 도메인이 있다면 그것도)

> ⚠️ 인증을 활성화하지 않으면 페이지의 동기화 배지가 "오류"로 표시됩니다. 콘솔에서 **익명 로그인**을 켜야 합니다.

## 로컬 실행

이 프로젝트는 빌드가 필요 없지만, ES module을 사용하므로 `file://`로 열면 동작하지 않습니다. 로컬 정적 서버 중 아무거나 사용하면 됩니다.

```bash
# Python
python3 -m http.server 5173

# 또는 Node
npx serve .
```

이후 `http://localhost:5173`을 엽니다.

## Vercel 배포

### 옵션 A: GitHub 연동 (권장)

1. GitHub에 레포를 푸시합니다 (이미 푸시되어 있습니다).
2. [Vercel](https://vercel.com/) → **Add New → Project**에서 이 레포를 가져옵니다.
3. Framework Preset은 **Other**(또는 자동 감지된 값) 그대로, Build Command와 Output Directory는 비워둡니다.
4. **Deploy**를 누르면 끝입니다. 배포된 도메인을 Firebase의 승인된 도메인에 추가하세요.

### 옵션 B: CLI

```bash
npm i -g vercel
vercel
# 첫 배포 후
vercel --prod
```

## 사용법

1. **가격 데이터** 섹션에서 CSV 파일을 업로드하거나, 구글 스프레드시트에서 헤더(`순번 / 번호 / 카드 이름 / 가격`)를 포함해 복사 → 붙여넣기.
2. **카드 추가**에서 일련번호(예: `SV10 075`)를 입력합니다. 자동완성 제안 + 미리보기가 표시됩니다.
3. **내 카드 목록**에서 수량을 직접 조정하거나 ＋/－/× 버튼으로 관리합니다. 합계 금액이 실시간 갱신됩니다.

## 데이터 모델

Firestore 경로:

```
/users/{uid}/data/catalog      -> { items: { [key]: {no, name, price} }, updatedAt }
/users/{uid}/data/collection   -> { items: { [key]: {no, name, price, qty} }, updatedAt }
```

- `key`는 일련번호를 소문자/공백 정규화한 값 (`SV10 075` → `sv10 075`).
- 단일 문서로 관리되어 한 번의 읽기/쓰기로 전체 상태를 동기화합니다.

## 주의

- 익명 인증의 UID는 브라우저(IndexedDB)에 저장됩니다. 시크릿 모드, 브라우저 데이터 삭제, 다른 기기에서는 다른 UID가 발급되어 데이터가 분리됩니다. 여러 기기에서 같은 데이터를 보고 싶으면 추후 Google/이메일 로그인을 추가하세요.
- Firebase 웹 API 키는 공개되어도 안전합니다. 데이터 보호는 위의 보안 규칙으로 이루어집니다.
