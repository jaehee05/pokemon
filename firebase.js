// Firebase initialization (loaded as ES module from gstatic CDN)
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBgn5tQ9Qu9pG-facKS98DIE8dzJQ7O3RA",
  authDomain: "pokemon-1eacb.firebaseapp.com",
  projectId: "pokemon-1eacb",
  storageBucket: "pokemon-1eacb.firebasestorage.app",
  messagingSenderId: "789010391006",
  appId: "1:789010391006:web:33d86fc1bb0a00522d874f",
  measurementId: "G-6WQ64MBYDH",
};

export const app = initializeApp(firebaseConfig);

let firestore;
try {
  firestore = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  });
} catch (e) {
  console.warn("Firestore persistent cache unavailable; falling back.", e);
  const { getFirestore } = await import(
    "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js"
  );
  firestore = getFirestore(app);
}

export const db = firestore;
export const auth = getAuth(app);
