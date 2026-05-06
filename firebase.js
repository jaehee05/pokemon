// Firebase initialization (loaded as ES module from gstatic CDN)
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBgn5tQ9Qu9pG-facKS98DIE8dzJQ7O3RA",
  authDomain: "pokemon-1eacb.firebaseapp.com",
  projectId: "pokemon-1eacb",
  storageBucket: "pokemon-1eacb.firebasestorage.app",
  messagingSenderId: "789010391006",
  appId: "1:789010391006:web:33d86fc1bb0a00522d874f",
  measurementId: "G-6WQ64MBYDH",
};

// 관리자 이메일 목록. 여기에 추가된 Google 계정만 인벤토리를 편집할 수 있습니다.
// firestore.rules 파일에도 같은 이메일을 추가해 서버 측 권한도 함께 제한하세요.
// 비어 있으면 로그인한 모든 사용자가 관리자로 취급됩니다 (개발용).
export const OWNER_EMAILS = ["jaehee05@kakao.com"];

export const app = initializeApp(firebaseConfig);

// iOS Safari의 ITP가 persistentLocalCache + signInWithRedirect 조합을 깨뜨리는 문제 회피.
// 모바일/Safari 에선 메모리 캐시만 사용.
const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
const isIOS = /iPad|iPhone|iPod/.test(ua);
const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|Edg|OPR/.test(ua);
const useMemoryCache = isIOS || isSafari;

let firestore;
try {
  firestore = initializeFirestore(
    app,
    useMemoryCache
      ? {}
      : { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) },
  );
} catch (e) {
  console.warn("Firestore custom cache unavailable; using default.", e);
  const { getFirestore } = await import(
    "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js"
  );
  firestore = getFirestore(app);
}

export const db = firestore;
export const storage = getStorage(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

// Persist auth across reloads (browser localStorage)
setPersistence(auth, browserLocalPersistence).catch((e) =>
  console.warn("auth persistence setup failed", e),
);
