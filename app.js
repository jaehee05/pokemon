import { auth, db, storage, googleProvider, OWNER_EMAILS } from "./firebase.js";
import {
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js";

// ---------- State ----------
let currentUser = null;
// items: key -> { no, name, grade, value, qty }
let items = new Map();
// sets: prefix -> name (예: "sv10" -> "로켓단의 영광")
let sets = new Map();

let inventoryUnsub = null;
let setsUnsub = null;
let initialLoaded = false;
let migrationAttempted = false;
let stateMigrationAttempted = false;

let pendingSaves = 0;
let savingTimer = null;

let sortKey = "value";
let sortDir = -1; // 1 asc, -1 desc
let activeState = ""; // "" = 전체, "__none__" = 미평가, "10".."0" = 정확한 점수

const GRADE_ORDER = ["RR", "SR", "SAR", "UR", "AR", "R", "U", "C"];
const GRADE_RANK = Object.fromEntries(GRADE_ORDER.map((g, i) => [g, i]));

const LEGACY_LS_KEYS = {
  catalog: "pokemon_catalog_v1",
  collection: "pokemon_collection_v1",
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  csvFile: $("csv-file"),
  pasteToggle: $("paste-toggle"),
  pasteArea: $("paste-area"),
  pasteInput: $("paste-input"),
  pasteApply: $("paste-apply"),
  pasteCancel: $("paste-cancel"),

  addForm: $("add-form"),
  cardNo: $("card-no"),
  cardName: $("card-name"),
  cardGrade: $("card-grade"),
  cardState: $("card-state"),
  cardValue: $("card-value"),
  cardQty: $("card-qty"),
  cardPreview: $("card-preview"),
  suggestions: $("suggestions"),

  inventoryBody: $("inventory-body"),
  inventoryEmpty: $("inventory-empty"),
  inventorySearch: $("inventory-search"),
  inventoryClear: $("inventory-clear"),
  imagesClearBtn: $("images-clear-btn"),
  inventoryCount: $("inventory-count"),
  inventoryTable: $("inventory-table"),
  cardGrid: $("card-grid"),
  sortSelect: $("sort-select"),
  exportBtn: $("export-btn"),

  gradeFilter: $("grade-filter"),
  statTypes: $("stat-types"),
  statQty: $("stat-qty"),
  statValue: $("stat-value"),
  statGrades: $("stat-grades"),

  syncBadge: $("sync-badge"),
  syncText: document.querySelector("#sync-badge .sync-text"),
  toast: $("toast"),

  authArea: $("auth-area"),

  imageInput: $("image-input"),
  lightbox: $("lightbox"),
  lightboxImg: $("lightbox-img"),
  lightboxClose: $("lightbox-close"),
  lightboxBackdrop: $("lightbox-backdrop"),

  cartFab: $("cart-fab"),
  cartFabCount: $("cart-fab-count"),
  cartDrawer: $("cart-drawer"),
  cartDrawerBody: $("cart-drawer-body"),
  cartDrawerClose: $("cart-drawer-close"),
  cartBackdrop: $("cart-backdrop"),
  cartTotalQty: $("cart-total-qty"),
  cartTotalValue: $("cart-total-value"),
  cartClear: $("cart-clear"),
  cartSubmit: $("cart-submit"),
  codeModal: $("code-modal"),
  codeModalBackdrop: $("code-modal-backdrop"),
  codeDisplay: $("code-display"),
  codeModalMeta: $("code-modal-meta"),
  codeCopy: $("code-copy"),
  codeClose: $("code-close"),
  requestForm: $("request-form"),
  requestCodeInput: $("request-code-input"),
  requestResult: $("request-result"),

  setsForm: $("sets-form"),
  setPrefix: $("set-prefix"),
  setName: $("set-name"),
  setsList: $("sets-list"),

  discountModal: $("discount-modal"),
  discountModalBackdrop: $("discount-modal-backdrop"),
  discountModalCard: $("discount-modal-card"),
  discountForm: $("discount-form"),
  discountPercent: $("discount-percent"),
  discountFinal: $("discount-final"),
  discountStart: $("discount-start"),
  discountEnd: $("discount-end"),
  discountRemove: $("discount-remove"),
  discountCancel: $("discount-cancel"),

  imageFormatOn: $("image-format-on"),
};

let currentUploadKey = null;
let currentDiscountKey = null;
let currentDiscountOriginal = 0;
let discountSyncing = false;
let imageAutoFormat = (() => {
  try { return localStorage.getItem("pokemon_image_auto_format") !== "0"; }
  catch (e) { return true; }
})();
let cart = {};
try {
  cart = JSON.parse(localStorage.getItem("pokemon_cart_v1") || "{}") || {};
} catch (e) { cart = {}; }
let lastRequest = null; // { code, data }

// ---------- Helpers ----------
function normalizeKey(s) {
  if (s == null) return "";
  return String(s).trim().toLowerCase().replace(/[\s\-_]+/g, "-");
}
function formatWon(n) {
  const v = Number(n) || 0;
  return "₩" + v.toLocaleString("ko-KR");
}
function parseInt0(raw) {
  if (raw == null) return 0;
  const s = String(raw).replace(/[^\d.-]/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function escapeHTML(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const escapeAttr = escapeHTML;

function normalizeGrade(raw) {
  if (raw == null) return "";
  const s = String(raw).trim().toUpperCase();
  return s;
}

function numericToLetter(n) {
  if (!Number.isFinite(n)) return null;
  if (n >= 9) return "S";
  if (n >= 6) return "A";
  if (n >= 1) return "B";
  return null;
}
function normalizeState(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") {
    const s = raw.trim().toUpperCase();
    if (s === "S" || s === "A" || s === "B") return s;
    const n = parseFloat(s);
    if (Number.isFinite(n)) return numericToLetter(n);
    return null;
  }
  if (typeof raw === "number") return numericToLetter(raw);
  return null;
}

const STATE_RANK = { S: 3, A: 2, B: 1 };
function stateRank(s) {
  return STATE_RANK[String(s || "").toUpperCase()] || 0;
}

function stateClass(s) {
  if (s == null) return "st-none";
  const u = String(s).toUpperCase();
  if (u === "S") return "st-s";
  if (u === "A") return "st-a";
  if (u === "B") return "st-b";
  return "st-none";
}

function stateLabel(s) {
  return s == null ? "—" : String(s);
}

// ---------- Discount helpers ----------
function parseISO(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function isDiscountActive(d, now = new Date()) {
  if (!d || !d.percent || d.percent <= 0) return false;
  const start = parseISO(d.startsAt);
  const end = parseISO(d.endsAt);
  if (start && start > now) return false;
  if (end && end < now) return false;
  return true;
}
function isDiscountScheduled(d, now = new Date()) {
  if (!d || !d.percent) return false;
  const start = parseISO(d.startsAt);
  return !!(start && start > now);
}
function isDiscountExpired(d, now = new Date()) {
  if (!d || !d.percent) return false;
  const end = parseISO(d.endsAt);
  return !!(end && end < now);
}
function getEffectivePrice(item) {
  const v = parseInt0(item && item.value);
  if (!item || !isDiscountActive(item.discount)) return v;
  const p = item.discount.percent || 0;
  return Math.max(0, Math.round((v * (100 - p)) / 100));
}
function timeUntilLabel(iso) {
  const target = parseISO(iso);
  if (!target) return "";
  const ms = target.getTime() - Date.now();
  if (ms <= 0) return "만료";
  const days = Math.floor(ms / 86400000);
  if (days >= 1) {
    const hours = Math.floor((ms % 86400000) / 3600000);
    return hours > 0 ? `${days}일 ${hours}시간 남음` : `${days}일 남음`;
  }
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) {
    const minutes = Math.floor((ms % 3600000) / 60000);
    return minutes > 0 ? `${hours}시간 ${minutes}분 남음` : `${hours}시간 남음`;
  }
  const minutes = Math.max(1, Math.floor(ms / 60000));
  return `${minutes}분 남음`;
}
function isoToLocalInput(iso) {
  // 날짜만 표시 (YYYY-MM-DD), 로컬 타임존 기준 자정으로 보고 날짜 추출
  const d = parseISO(iso);
  if (!d) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localInputToISO(local) {
  if (!local) return null;
  // "YYYY-MM-DD" → 로컬 자정으로 해석 (브라우저 기본은 UTC 자정이라 명시 필요)
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(local) ? local + "T00:00:00" : local;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isOwner(user) {
  if (!user || !user.email) return false;
  if (!Array.isArray(OWNER_EMAILS) || OWNER_EMAILS.length === 0) return true;
  return OWNER_EMAILS.includes(user.email);
}

function setSyncStatus(state, text) {
  els.syncBadge.dataset.state = state;
  if (text) els.syncText.textContent = text;
  else {
    const map = {
      connecting: "연결 중…",
      synced: "동기화됨",
      saving: "저장 중…",
      offline: "오프라인",
      error: "오류",
      readonly: "읽기 전용",
    };
    els.syncText.textContent = map[state] || state;
  }
}

function showToast(message, type = "") {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.remove("error", "success");
  if (type) els.toast.classList.add(type);
  els.toast.classList.add("show");
  els.toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    els.toast.classList.remove("show");
  }, 2400);
}

// ---------- CSV parsing ----------
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs >= commas ? "\t" : ",";
}
function parseCSV(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delimiter) { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}
function findColumnIndex(header, candidates) {
  const norm = header.map((h) => String(h).trim().toLowerCase());
  for (const cand of candidates) {
    const idx = norm.findIndex((h) => h.includes(cand));
    if (idx !== -1) return idx;
  }
  return -1;
}

async function importFromText(text) {
  if (!isOwner(currentUser)) {
    showToast("관리자 로그인 후 이용 가능합니다.", "error");
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    showToast("붙여넣을 내용이 없습니다.", "error");
    return;
  }
  const delim = detectDelimiter(trimmed);
  const rows = parseCSV(trimmed, delim);
  if (rows.length === 0) {
    showToast("데이터를 인식할 수 없습니다.", "error");
    return;
  }

  let header = rows[0];
  let dataRows = rows.slice(1);
  const looksLikeHeader = header.some((h) =>
    /일련번호|번호|카드|등급|상태|가치|가격|수량|보유|name|grade|state|condition|value|price|qty/i.test(String(h)),
  );
  if (!looksLikeHeader) {
    header = ["일련번호", "카드명", "등급", "상태", "가치", "보유 수량"];
    dataRows = rows;
  }

  const noIdx = findColumnIndex(header, ["일련번호", "번호", "no", "number", "code"]);
  const nameIdx = findColumnIndex(header, ["카드명", "이름", "name", "카드"]);
  const gradeIdx = findColumnIndex(header, ["등급", "grade", "rarity"]);
  const stateIdx = findColumnIndex(header, ["상태", "state", "condition"]);
  const valueIdx = findColumnIndex(header, ["가치", "가격", "value", "price", "원"]);
  const qtyIdx = findColumnIndex(header, ["보유", "수량", "qty", "quantity"]);

  if (noIdx === -1) {
    showToast("일련번호 열을 찾을 수 없습니다.", "error");
    return;
  }

  const next = new Map(items);
  let added = 0;
  let updated = 0;
  for (const r of dataRows) {
    const no = (r[noIdx] || "").trim();
    if (!no) continue;
    const key = normalizeKey(no);
    if (!key) continue;
    const name = nameIdx >= 0 ? (r[nameIdx] || "").trim() : "";
    const grade = gradeIdx >= 0 ? normalizeGrade(r[gradeIdx]) : "";
    const stateRaw = stateIdx >= 0 ? r[stateIdx] : "";
    const state = stateIdx >= 0 ? normalizeState(stateRaw) : null;
    const value = valueIdx >= 0 ? parseInt0(r[valueIdx]) : 0;
    const qty = qtyIdx >= 0 ? Math.max(0, parseInt0(r[qtyIdx])) : 1;

    const existing = next.get(key);
    if (existing) updated++;
    else added++;
    next.set(key, {
      ...(existing || {}),
      no: no,
      name: name || (existing && existing.name) || "",
      grade: grade || (existing && existing.grade) || "",
      state: state != null ? state : (existing ? existing.state : null),
      value: value || (existing && existing.value) || 0,
      qty: qty,
    });
  }
  if (added + updated === 0) {
    showToast("유효한 데이터 행이 없습니다.", "error");
    return;
  }
  items = next;
  await saveInventory();
  renderAll();
  showToast(`가져오기 완료: 신규 ${added}건, 업데이트 ${updated}건`, "success");
}

// ---------- Firestore I/O ----------
function inventoryDocRef() {
  return doc(db, "public", "inventory");
}
function legacyUserCatalogRef(uid) {
  return doc(db, "users", uid, "data", "catalog");
}
function legacyUserCollectionRef(uid) {
  return doc(db, "users", uid, "data", "collection");
}
function legacyUserInventoryRef(uid) {
  return doc(db, "users", uid, "data", "inventory");
}

function mapToObject(map) {
  const out = {};
  for (const [k, v] of map) out[k] = v;
  return out;
}

async function saveInventory() {
  if (!isOwner(currentUser)) {
    showToast("관리자만 저장할 수 있습니다.", "error");
    return;
  }
  beginSaving();
  try {
    await setDoc(inventoryDocRef(), {
      items: mapToObject(items),
      updatedAt: serverTimestamp(),
      updatedBy: currentUser?.email || null,
    });
  } catch (e) {
    console.error("saveInventory failed", e);
    showToast("저장 실패: " + (e.message || e), "error");
  } finally {
    endSaving();
  }
}

function beginSaving() {
  pendingSaves++;
  setSyncStatus("saving");
}
function endSaving() {
  pendingSaves = Math.max(0, pendingSaves - 1);
  if (pendingSaves === 0) {
    clearTimeout(savingTimer);
    savingTimer = setTimeout(() => {
      if (pendingSaves === 0) refreshSyncStatus();
    }, 250);
  }
}

function refreshSyncStatus() {
  if (!navigator.onLine) {
    setSyncStatus("offline");
    return;
  }
  if (!currentUser) {
    setSyncStatus("readonly");
    return;
  }
  setSyncStatus("synced");
}

async function migrateNumericStates() {
  if (stateMigrationAttempted) return;
  if (!isOwner(currentUser)) return;
  let changed = false;
  for (const [k, v] of items) {
    if (typeof v.state === "number") {
      const letter = numericToLetter(v.state);
      items.set(k, { ...v, state: letter });
      changed = true;
    }
  }
  if (changed) {
    stateMigrationAttempted = true;
    await saveInventory();
  } else {
    stateMigrationAttempted = true;
  }
}

function attachInventoryListener() {
  if (inventoryUnsub) inventoryUnsub();

  inventoryUnsub = onSnapshot(
    inventoryDocRef(),
    (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const obj = (data && data.items) || {};
      items = new Map(Object.entries(obj));
      migrateNumericStates();
      renderAll();
      if (!snap.metadata.hasPendingWrites && pendingSaves === 0) {
        refreshSyncStatus();
      }
      if (!initialLoaded) {
        initialLoaded = true;
        if (isOwner(currentUser)) maybeMigrate();
      }
    },
    (err) => {
      console.error("inventory snapshot error", err);
      setSyncStatus("error", "권한 오류");
      showToast("동기화 실패: " + (err.message || err), "error");
    },
  );
}

async function maybeMigrate() {
  if (migrationAttempted) return;
  migrationAttempted = true;
  if (items.size > 0) return;
  if (!currentUser) return;

  const uid = currentUser.uid;
  try {
    // 1) Migrate from legacy /users/{uid}/data/inventory
    const personalSnap = await getDoc(legacyUserInventoryRef(uid));
    if (personalSnap.exists()) {
      const obj = (personalSnap.data() && personalSnap.data().items) || {};
      const merged = new Map();
      for (const [k, v] of Object.entries(obj)) {
        merged.set(normalizeKey(k), {
          no: v.no || k,
          name: v.name || "",
          grade: normalizeGrade(v.grade || ""),
          value: parseInt0(v.value),
          qty: parseInt0(v.qty),
        });
      }
      if (merged.size > 0) {
        items = merged;
        await saveInventory();
        showToast(`개인 인벤토리 ${merged.size}건을 공개 인벤토리로 옮겼습니다.`, "success");
        return;
      }
    }

    // 2) Migrate from legacy catalog + collection per-user docs
    const [catalogSnap, collectionSnap] = await Promise.all([
      getDoc(legacyUserCatalogRef(uid)),
      getDoc(legacyUserCollectionRef(uid)),
    ]);
    const catalog = (catalogSnap.exists() && catalogSnap.data().items) || null;
    const collectionItems = (collectionSnap.exists() && collectionSnap.data().items) || null;
    if (catalog || collectionItems) {
      const merged = new Map();
      if (catalog) {
        for (const [k, v] of Object.entries(catalog)) {
          merged.set(normalizeKey(k), {
            no: v.no || k,
            name: v.name || "",
            grade: "",
            value: parseInt0(v.price),
            qty: 0,
          });
        }
      }
      if (collectionItems) {
        for (const [k, v] of Object.entries(collectionItems)) {
          const key = normalizeKey(k);
          const existing = merged.get(key);
          merged.set(key, {
            no: (existing && existing.no) || v.no || k,
            name: (existing && existing.name) || v.name || "",
            grade: (existing && existing.grade) || "",
            value: (existing && existing.value) || parseInt0(v.price),
            qty: parseInt0(v.qty),
          });
        }
      }
      for (const [k, v] of merged) {
        if (!v.qty && !v.value && !v.name) merged.delete(k);
      }
      if (merged.size > 0) {
        items = merged;
        await saveInventory();
        showToast(`기존 데이터 ${merged.size}건을 옮겼습니다.`, "success");
        return;
      }
    }
  } catch (e) {
    console.warn("legacy firestore migration skipped", e);
  }

  // 3) localStorage legacy migration
  try {
    const oldCatalog = localStorage.getItem(LEGACY_LS_KEYS.catalog);
    const oldCollection = localStorage.getItem(LEGACY_LS_KEYS.collection);
    if (!oldCatalog && !oldCollection) return;

    const merged = new Map();
    if (oldCatalog) {
      const obj = JSON.parse(oldCatalog);
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          merged.set(normalizeKey(k), {
            no: v.no || k,
            name: v.name || "",
            grade: "",
            value: parseInt0(v.price),
            qty: 0,
          });
        }
      }
    }
    if (oldCollection) {
      const obj = JSON.parse(oldCollection);
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          const key = normalizeKey(k);
          const existing = merged.get(key);
          merged.set(key, {
            no: (existing && existing.no) || v.no || k,
            name: (existing && existing.name) || v.name || "",
            grade: (existing && existing.grade) || "",
            value: (existing && existing.value) || parseInt0(v.price),
            qty: parseInt0(v.qty),
          });
        }
      }
    }
    for (const [k, v] of merged) {
      if (!v.qty && !v.value && !v.name) merged.delete(k);
    }
    if (merged.size > 0) {
      items = merged;
      await saveInventory();
      localStorage.removeItem(LEGACY_LS_KEYS.catalog);
      localStorage.removeItem(LEGACY_LS_KEYS.collection);
      showToast(`이전 브라우저 데이터 ${merged.size}건을 가져왔습니다.`, "success");
    }
  } catch (e) {
    console.warn("localStorage migration failed", e);
  }
}

// ---------- Render ----------
function renderAll() {
  applyOwnerMode();
  renderStats();
  renderGradeFilter();
  renderInventory();
  renderCart();
}

function applyOwnerMode() {
  const owner = isOwner(currentUser);
  document.body.classList.toggle("is-owner", owner);
  document.body.classList.toggle("is-readonly", !owner);
  renderAuthArea();
}

function renderAuthArea() {
  const area = els.authArea;
  if (!area) return;
  if (currentUser) {
    const owner = isOwner(currentUser);
    const name = currentUser.displayName || currentUser.email || "사용자";
    const email = currentUser.email || "";
    area.innerHTML = `
      <div class="user-chip">
        <span class="role-badge ${owner ? "admin" : "guest"}">${owner ? "관리자" : "읽기 전용"}</span>
        <span class="user-meta">
          <span class="user-name">${escapeHTML(name)}</span>
          ${email && email !== name ? `<span class="user-email">${escapeHTML(email)}</span>` : ""}
        </span>
        <button class="btn btn-light" id="logout-btn" type="button">로그아웃</button>
      </div>
    `;
    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);
  } else {
    // 비로그인 상태에서는 표시할 UI 없음.
    // 관리자 로그인은 헤더의 PokeStock 로고를 3연속 클릭하면 호출됩니다.
    area.innerHTML = "";
  }
}

function renderStats() {
  let totalQty = 0;
  let totalValue = 0;
  const byState = new Map();
  for (const [, v] of items) {
    const qty = Number(v.qty) || 0;
    const val = Number(v.value) || 0;
    totalQty += qty;
    totalValue += qty * val;
    const s = v.state == null ? "__none__" : String(v.state);
    const cur = byState.get(s) || { types: 0, qty: 0 };
    cur.types += 1;
    cur.qty += qty;
    byState.set(s, cur);
  }
  els.statTypes.textContent = items.size.toLocaleString("ko-KR");
  els.statQty.textContent = totalQty.toLocaleString("ko-KR");
  els.statValue.textContent = formatWon(totalValue);

  const orderedStates = Array.from(byState.keys()).sort((a, b) => {
    if (a === "__none__") return 1;
    if (b === "__none__") return -1;
    return stateRank(b) - stateRank(a); // S → A → B
  });
  els.statGrades.innerHTML = "";
  for (const s of orderedStates) {
    const stat = byState.get(s);
    const letter = s === "__none__" ? null : s;
    const pill = document.createElement("div");
    pill.className = "grade-pill";
    pill.innerHTML = `
      <span class="state-badge ${stateClass(letter)}">${letter == null ? "—" : escapeHTML(letter)}</span>
      <span class="grade-pill-text">${stat.types}종 · ${stat.qty}장</span>
    `;
    els.statGrades.appendChild(pill);
  }
}

function gradeClass(g) {
  const u = String(g || "").toUpperCase();
  if (u === "RR") return "g-rr";
  if (u === "R") return "g-r";
  if (u === "U") return "g-u";
  if (u === "C") return "g-u";
  if (u === "AR") return "g-ar";
  if (u === "SR") return "g-sr";
  if (u === "SAR") return "g-sar";
  if (u === "UR") return "g-ur";
  return "g-none";
}

function renderGradeFilter() {
  const container = els.gradeFilter;
  const presentStates = new Set();
  for (const [, v] of items) presentStates.add(v.state == null ? "__none__" : String(v.state));
  const states = Array.from(presentStates)
    .filter((s) => s !== "__none__")
    .sort((a, b) => stateRank(b) - stateRank(a)); // S → A → B

  container.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.className = "chip" + (activeState === "" ? " active" : "");
  allBtn.dataset.state = "";
  allBtn.textContent = "전체";
  container.appendChild(allBtn);
  for (const s of states) {
    const btn = document.createElement("button");
    btn.className = "chip" + (activeState === s ? " active" : "");
    btn.dataset.state = s;
    btn.innerHTML = `<span class="state-badge ${stateClass(s)}">${escapeHTML(s)}</span>`;
    container.appendChild(btn);
  }
  if (presentStates.has("__none__")) {
    const btn = document.createElement("button");
    btn.className = "chip" + (activeState === "__none__" ? " active" : "");
    btn.dataset.state = "__none__";
    btn.textContent = "미평가";
    container.appendChild(btn);
  }
}

function compareItems(a, b) {
  // 품절 상품은 정렬 방향과 무관하게 항상 뒤로
  const aSold = (parseInt0(a.qty) || 0) <= 0;
  const bSold = (parseInt0(b.qty) || 0) <= 0;
  if (aSold !== bSold) return aSold ? 1 : -1;

  const dir = sortDir;
  switch (sortKey) {
    case "no":
      return a.no.localeCompare(b.no, "ko", { numeric: true }) * dir;
    case "name":
      return (a.name || "").localeCompare(b.name || "", "ko") * dir;
    case "grade": {
      const ra = GRADE_RANK[a.grade] != null ? GRADE_RANK[a.grade] : 99;
      const rb = GRADE_RANK[b.grade] != null ? GRADE_RANK[b.grade] : 99;
      if (ra !== rb) return (ra - rb) * dir;
      return a.no.localeCompare(b.no, "ko", { numeric: true });
    }
    case "state": {
      const ra = stateRank(a.state);
      const rb = stateRank(b.state);
      if (ra === 0 && rb === 0) return a.no.localeCompare(b.no, "ko", { numeric: true });
      if (ra === 0) return 1;
      if (rb === 0) return -1;
      if (ra !== rb) return (ra - rb) * dir;
      return a.no.localeCompare(b.no, "ko", { numeric: true });
    }
    case "value": {
      const av = getEffectivePrice(a);
      const bv = getEffectivePrice(b);
      return (av - bv) * dir || a.no.localeCompare(b.no, "ko", { numeric: true });
    }
    case "qty":
      return ((a.qty || 0) - (b.qty || 0)) * dir || a.no.localeCompare(b.no, "ko", { numeric: true });
    case "total": {
      const at = (a.qty || 0) * getEffectivePrice(a);
      const bt = (b.qty || 0) * getEffectivePrice(b);
      return (at - bt) * dir || a.no.localeCompare(b.no, "ko", { numeric: true });
    }
  }
  return 0;
}

function renderInventory() {
  const owner = isOwner(currentUser);
  const tbody = els.inventoryBody;
  tbody.innerHTML = "";
  const q = String(els.inventorySearch.value || "").trim().toLowerCase();

  const all = [];
  for (const [key, v] of items) {
    all.push({ key, ...v });
  }
  all.sort(compareItems);

  let filtered = all;
  if (activeState === "__none__") {
    filtered = filtered.filter((r) => r.state == null);
  } else if (activeState !== "") {
    filtered = filtered.filter((r) => r.state === activeState);
  }
  if (q) {
    filtered = filtered.filter(
      (r) =>
        r.no.toLowerCase().includes(q) ||
        (r.name || "").toLowerCase().includes(q),
    );
  }

  if (owner) {
    for (const r of filtered) {
      const total = (r.qty || 0) * (r.value || 0);
      const tr = document.createElement("tr");
      tr.dataset.key = r.key;
      const thumbCell = thumbCellHTML(r, true);
      tr.innerHTML = `
        <td class="thumb-cell">${thumbCell}</td>
        <td class="mono no-cell">${setChipHTML(r.no)}<span class="no-text">${escapeHTML(r.no)}</span></td>
        <td><span class="cell-edit" data-field="name" tabindex="0">${escapeHTML(r.name || "")}<span class="cell-empty">${r.name ? "" : "이름 없음"}</span></span></td>
        <td>
          <select class="state-input ${stateClass(r.state)}" data-field="state" aria-label="상태">
            <option value="" ${r.state == null ? "selected" : ""}>—</option>
            <option value="S" ${r.state === "S" ? "selected" : ""}>S</option>
            <option value="A" ${r.state === "A" ? "selected" : ""}>A</option>
            <option value="B" ${r.state === "B" ? "selected" : ""}>B</option>
          </select>
        </td>
        <td class="num"><input type="number" class="value-input" data-field="value" min="0" step="100" value="${r.value || 0}" aria-label="가격" /></td>
        <td class="discount-cell">${discountCellHTML(r)}</td>
        <td class="num">
          <div class="qty-cell">
            <button class="icon-btn" data-act="dec" title="−1">−</button>
            <input type="number" class="qty-input" data-field="qty" min="0" step="1" value="${r.qty || 0}" aria-label="재고" />
            <button class="icon-btn" data-act="inc" title="+1">+</button>
          </div>
        </td>
        <td class="num total-cell">${formatWon((r.qty || 0) * getEffectivePrice(r))}</td>
        <td><button class="icon-btn danger" data-act="remove" title="삭제">×</button></td>
      `;
      tbody.appendChild(tr);
    }
  } else {
    renderBuyerCards(filtered);
  }

  syncSortSelect();
  els.inventoryCount.textContent = `${filtered.length.toLocaleString("ko-KR")} / ${items.size.toLocaleString("ko-KR")}건`;

  if (items.size === 0) {
    els.inventoryEmpty.textContent = owner
      ? "아직 등록된 카드가 없습니다. 위에서 카드를 추가하세요."
      : "등록된 카드가 없습니다.";
    els.inventoryEmpty.classList.remove("hidden");
  } else if (filtered.length === 0) {
    els.inventoryEmpty.textContent = "조건에 맞는 카드가 없습니다.";
    els.inventoryEmpty.classList.remove("hidden");
  } else {
    els.inventoryEmpty.classList.add("hidden");
  }

  const ths = els.inventoryTable.querySelectorAll("th.sortable");
  ths.forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortKey) {
      th.classList.add(sortDir === 1 ? "sort-asc" : "sort-desc");
    }
  });
}

function renderBuyerCards(filtered) {
  const grid = els.cardGrid;
  if (!grid) return;
  grid.innerHTML = "";
  for (const r of filtered) {
    const card = document.createElement("article");
    card.className = "market-card";
    card.dataset.key = r.key;
    if (r.imageUrl) card.classList.add("has-image");
    if (!r.qty) card.classList.add("sold-out");

    const hasDiscount = isDiscountActive(r.discount);
    const eff = getEffectivePrice(r);
    const orig = parseInt0(r.value);

    const overlays = `
      ${r.state != null ? `<span class="market-card-state state-badge ${stateClass(r.state)}">${escapeHTML(r.state)}</span>` : ""}
      ${r.qty > 0
        ? `<span class="market-card-stock-badge">재고 ${r.qty}</span>`
        : `<span class="market-card-stock-badge sold-out">품절</span>`}
    `;

    const imageBlock = r.imageUrl
      ? `<div class="market-card-image">
           ${overlays}
           <img src="${escapeAttr(r.imageUrl)}${r.imageUpdatedAt ? `?t=${r.imageUpdatedAt}` : ""}" loading="lazy" alt="${escapeAttr(r.name || r.no)}" />
         </div>`
      : `<div class="market-card-image market-card-image-empty">
           ${overlays}
           <span>사진 준비 중</span>
         </div>`;

    const cartQty = getCartQty(r.key);
    const stock = Math.max(0, parseInt0(r.qty));
    const cartFull = stock > 0 && cartQty >= stock;
    let addBtn;
    if (stock <= 0) {
      addBtn = `<button class="market-card-add" type="button" disabled>품절</button>`;
    } else if (cartQty > 0) {
      addBtn = `<button class="market-card-add added" type="button" data-cart-act="add" data-key="${escapeAttr(r.key)}" ${cartFull ? "disabled" : ""}>담김 (${cartQty})</button>`;
    } else {
      addBtn = `<button class="market-card-add" type="button" data-cart-act="add" data-key="${escapeAttr(r.key)}">담기</button>`;
    }

    const priceBlock = hasDiscount
      ? `<div class="market-card-prices">
           <div class="market-card-price-row"><span class="market-card-percent">${r.discount.percent}%</span><span class="market-card-orig">${formatWon(orig)}</span></div>
           <span class="market-card-final">${formatWon(eff)}</span>
         </div>`
      : `<span class="market-card-price">${formatWon(orig)}</span>`;

    card.innerHTML = `
      ${imageBlock}
      <div class="market-card-body">
        <span class="market-card-no">${setChipHTML(r.no)}<span>${escapeHTML(r.no)}</span></span>
        <h3 class="market-card-title">${escapeHTML(r.name || "이름 미등록")}</h3>
        <div class="market-card-bottom">
          ${priceBlock}
          ${addBtn}
        </div>
      </div>
    `;
    grid.appendChild(card);
  }
}

function syncSortSelect() {
  if (!els.sortSelect) return;
  const v = `${sortKey}|${sortDir}`;
  const opt = Array.from(els.sortSelect.options).find((o) => o.value === v);
  els.sortSelect.value = opt ? v : "no|1";
}

function discountCellHTML(r) {
  const d = r.discount;
  if (!d || !d.percent) {
    return `<button class="discount-btn empty" type="button" data-discount-btn>＋ 할인</button>`;
  }
  const expired = isDiscountExpired(d);
  const scheduled = isDiscountScheduled(d);
  const active = isDiscountActive(d);
  let cls = "active";
  let sub = "활성";
  if (expired) { cls = "expired"; sub = "만료"; }
  else if (scheduled) { cls = "scheduled"; sub = `D-${Math.max(1, Math.ceil((parseISO(d.startsAt) - Date.now()) / 86400000))}`; }
  else if (active && d.endsAt) sub = timeUntilLabel(d.endsAt);
  else if (active) sub = "무기한";
  return `<button class="discount-btn ${cls}" type="button" data-discount-btn><span class="percent">${d.percent}%</span><span class="sub">${escapeHTML(sub)}</span></button>`;
}

function openDiscountModal(key) {
  if (!isOwner(currentUser)) return;
  const k = normalizeKey(key);
  const entry = items.get(k);
  if (!entry) return;
  currentDiscountKey = k;
  currentDiscountOriginal = parseInt0(entry.value);
  els.discountModalCard.textContent = `${entry.no}${entry.name ? " · " + entry.name : ""} · 원가 ${formatWon(currentDiscountOriginal)}`;
  const d = entry.discount || {};
  const percent = d.percent || "";
  els.discountPercent.value = percent;
  if (percent && currentDiscountOriginal > 0) {
    els.discountFinal.value = Math.round((currentDiscountOriginal * (100 - percent)) / 100);
  } else {
    els.discountFinal.value = "";
  }
  els.discountStart.value = isoToLocalInput(d.startsAt);
  els.discountEnd.value = isoToLocalInput(d.endsAt);
  els.discountModal.hidden = false;
  document.body.classList.add("modal-open");
  setTimeout(() => els.discountPercent.focus(), 0);
}
function closeDiscountModal() {
  els.discountModal.hidden = true;
  document.body.classList.remove("modal-open");
  currentDiscountKey = null;
}
async function persistDiscount(key, discount) {
  if (!isOwner(currentUser)) return;
  const k = normalizeKey(key);
  const entry = items.get(k);
  if (!entry) return;
  const next = { ...entry };
  if (!discount || !discount.percent) delete next.discount;
  else next.discount = discount;
  items.set(k, next);
  renderAll();
  await saveInventory();
}

function thumbCellHTML(r, owner) {
  const url = r.imageUrl;
  if (url) {
    const cacheBust = r.imageUpdatedAt ? `?t=${r.imageUpdatedAt}` : "";
    const imgHtml = `<img src="${escapeAttr(url)}${cacheBust}" loading="lazy" alt="${escapeAttr(r.name || r.no)}" />`;
    if (owner) {
      return `<div class="thumb has-image" data-img-action="view" title="크게 보기">
        ${imgHtml}
        <div class="thumb-actions">
          <button class="thumb-btn" data-img-action="upload" type="button" title="사진 변경">↺</button>
          <button class="thumb-btn danger" data-img-action="delete" type="button" title="사진 제거">×</button>
        </div>
      </div>`;
    }
    return `<div class="thumb has-image" data-img-action="view" title="크게 보기">${imgHtml}</div>`;
  }
  if (owner) {
    return `<button class="thumb thumb-add" data-img-action="upload" type="button" title="사진 업로드">＋</button>`;
  }
  return `<div class="thumb thumb-empty">—</div>`;
}

// ---------- Images ----------
async function resizeImage(file, maxDim = 900, quality = 0.85) {
  if (!file.type || !file.type.startsWith("image/")) {
    throw new Error("이미지 파일이 아닙니다.");
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("파일 읽기 실패"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("이미지 로드 실패 (HEIC 등 미지원 포맷일 수 있음)"));
    im.src = dataUrl;
  });
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
    else { width = Math.round((width * maxDim) / height); height = maxDim; }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("이미지 변환 실패"))),
      "image/jpeg",
      quality,
    );
  });
}

function safeStoragePath(key) {
  return String(key).replace(/[^a-z0-9-]/g, "_");
}

async function formatCardImage(file, options = {}) {
  const {
    outputSize = 1000,
    cardSizeRatio = 0.9,
    quality = 0.88,
    background = "#ffffff",
  } = options;
  if (!file.type || !file.type.startsWith("image/")) {
    throw new Error("이미지 파일이 아닙니다.");
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("파일 읽기 실패"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("이미지 로드 실패 (HEIC 등 미지원 포맷일 수 있음)"));
    im.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, outputSize, outputSize);
  const maxDim = outputSize * cardSizeRatio;
  const ratio = img.width / img.height;
  let drawW, drawH;
  if (ratio >= 1) {
    drawW = maxDim;
    drawH = drawW / ratio;
  } else {
    drawH = maxDim;
    drawW = drawH * ratio;
  }
  const drawX = (outputSize - drawW) / 2;
  const drawY = (outputSize - drawH) / 2;
  ctx.drawImage(img, drawX, drawY, drawW, drawH);
  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("이미지 변환 실패"))),
      "image/jpeg",
      quality,
    );
  });
}

async function uploadCardImage(key, file) {
  if (!isOwner(currentUser)) {
    showToast("관리자만 업로드할 수 있습니다.", "error");
    return;
  }
  const k = normalizeKey(key);
  const entry = items.get(k);
  if (!entry) return;
  showToast(imageAutoFormat ? "사진 자동 정렬 중…" : "이미지 업로드 중…");
  try {
    const blob = imageAutoFormat
      ? await formatCardImage(file, { outputSize: 1000, cardSizeRatio: 0.65, background: "#000000" })
      : await resizeImage(file, 900, 0.85);
    const path = `cards/${safeStoragePath(k)}.jpg`;
    const ref = storageRef(storage, path);
    await uploadBytes(ref, blob, {
      contentType: "image/jpeg",
      cacheControl: "public, max-age=31536000",
    });
    const url = await getDownloadURL(ref);
    items.set(k, { ...entry, imageUrl: url, imagePath: path, imageUpdatedAt: Date.now() });
    await saveInventory();
    renderAll();
    showToast("이미지가 업로드되었습니다.", "success");
  } catch (err) {
    console.error("image upload failed", err);
    showToast("업로드 실패: " + (err.message || err), "error");
  }
}

async function deleteCardImage(key) {
  if (!isOwner(currentUser)) return;
  if (!confirm("이미지를 제거할까요?")) return;
  const k = normalizeKey(key);
  const entry = items.get(k);
  if (!entry) return;
  try {
    if (entry.imagePath) {
      try {
        await deleteObject(storageRef(storage, entry.imagePath));
      } catch (e) {
        console.warn("storage delete (non-fatal)", e);
      }
    }
    const next = { ...entry };
    delete next.imageUrl;
    delete next.imagePath;
    delete next.imageUpdatedAt;
    items.set(k, next);
    await saveInventory();
    renderAll();
    showToast("이미지가 제거되었습니다.", "success");
  } catch (err) {
    console.error("image delete failed", err);
    showToast("실패: " + (err.message || err), "error");
  }
}

async function bulkRemoveImages() {
  if (!isOwner(currentUser)) return;
  const withImages = Array.from(items.entries()).filter(([, v]) => v && v.imageUrl);
  if (withImages.length === 0) {
    showToast("제거할 이미지가 없습니다.", "error");
    return;
  }
  if (!confirm(`총 ${withImages.length}장의 카드 이미지를 모두 제거할까요?\n\n인벤토리 카드 자체는 그대로 유지되고, 사진만 제거됩니다.\n되돌릴 수 없습니다.`)) return;

  showToast(`이미지 ${withImages.length}장 제거 중…`);
  let success = 0;
  let failed = 0;
  // Storage 삭제는 best-effort (병렬 배치)
  const batchSize = 8;
  for (let i = 0; i < withImages.length; i += batchSize) {
    const batch = withImages.slice(i, i + batchSize);
    await Promise.all(batch.map(async ([key, entry]) => {
      try {
        if (entry.imagePath) {
          try { await deleteObject(storageRef(storage, entry.imagePath)); }
          catch (e) { console.warn(`storage delete (non-fatal) ${key}`, e); }
        }
        const next = { ...entry };
        delete next.imageUrl;
        delete next.imagePath;
        delete next.imageUpdatedAt;
        items.set(key, next);
        success++;
      } catch (e) {
        console.error(`bulk image remove failed for ${key}`, e);
        failed++;
      }
    }));
  }
  await saveInventory();
  renderAll();
  showToast(
    `이미지 ${success}장 제거 완료${failed > 0 ? ` (실패 ${failed})` : ""}`,
    failed > 0 ? "error" : "success",
  );
}

function openLightbox(url) {
  if (!url) return;
  els.lightboxImg.src = url;
  els.lightbox.hidden = false;
  document.body.classList.add("lightbox-open");
}
function closeLightbox() {
  els.lightbox.hidden = true;
  els.lightboxImg.src = "";
  document.body.classList.remove("lightbox-open");
}

// ---------- Sets (확장팩 라벨) ----------
function getSetPrefix(no) {
  if (!no) return "";
  const s = String(no).split(/[-\s_]/)[0];
  return s ? s.toLowerCase() : "";
}
function getSetName(no) {
  const p = getSetPrefix(no);
  return p ? (sets.get(p) || "") : "";
}
function setChipHTML(no) {
  const name = getSetName(no);
  return name ? `<span class="set-chip">${escapeHTML(name)}</span>` : "";
}

function setsDocRef() { return doc(db, "public", "sets"); }

function attachSetsListener() {
  if (setsUnsub) setsUnsub();
  setsUnsub = onSnapshot(
    setsDocRef(),
    (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const obj = (data && data.items) || {};
      sets = new Map(Object.entries(obj));
      renderSets();
      renderInventory();
    },
    (err) => {
      console.warn("sets snapshot error", err);
    },
  );
}

async function saveSets() {
  if (!isOwner(currentUser)) return;
  const obj = {};
  for (const [k, v] of sets) obj[k] = v;
  beginSaving();
  try {
    await setDoc(setsDocRef(), {
      items: obj,
      updatedAt: serverTimestamp(),
      updatedBy: currentUser?.email || null,
    });
  } catch (e) {
    console.error("saveSets failed", e);
    showToast("라벨 저장 실패: " + (e.message || e), "error");
  } finally {
    endSaving();
  }
}

async function upsertSet(prefix, name) {
  if (!isOwner(currentUser)) return;
  const p = String(prefix || "").trim().toLowerCase();
  const n = String(name || "").trim();
  if (!p || !n) {
    showToast("접두어와 이름을 모두 입력하세요.", "error");
    return;
  }
  sets.set(p, n);
  renderSets();
  renderInventory();
  await saveSets();
  showToast(`라벨 저장: ${p} → ${n}`, "success");
}

async function removeSet(prefix) {
  if (!isOwner(currentUser)) return;
  const p = String(prefix || "").trim().toLowerCase();
  if (!sets.has(p)) return;
  if (!confirm(`'${p}' 라벨을 삭제할까요?`)) return;
  sets.delete(p);
  renderSets();
  renderInventory();
  await saveSets();
}

function renderSets() {
  const list = els.setsList;
  if (!list) return;
  list.innerHTML = "";
  if (sets.size === 0) {
    list.innerHTML = `<p class="empty sets-empty">등록된 라벨이 없습니다.</p>`;
    return;
  }
  const sorted = Array.from(sets.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [prefix, name] of sorted) {
    const item = document.createElement("div");
    item.className = "set-item";
    item.innerHTML = `
      <span class="set-chip">${escapeHTML(name)}</span>
      <span class="set-item-prefix">${escapeHTML(prefix)}</span>
      <button class="icon-btn danger" data-set-remove="${escapeAttr(prefix)}" type="button" aria-label="삭제">×</button>
    `;
    list.appendChild(item);
  }
}

// ---------- Cart ----------
function persistCart() {
  try { localStorage.setItem("pokemon_cart_v1", JSON.stringify(cart)); } catch (e) {}
}
function cartCount() {
  let n = 0;
  for (const k in cart) n += cart[k] || 0;
  return n;
}
function getCartQty(key) {
  return cart[normalizeKey(key)] || 0;
}
function addToCart(key, delta = 1) {
  const k = normalizeKey(key);
  const item = items.get(k);
  if (!item) return;
  const stock = Math.max(0, parseInt0(item.qty));
  if (stock <= 0 && delta > 0) {
    showToast("품절된 카드입니다.", "error");
    return;
  }
  const cur = cart[k] || 0;
  let next = cur + delta;
  if (next > stock) {
    next = stock;
    showToast(`재고는 최대 ${stock}장까지 담을 수 있어요.`, "error");
  }
  if (next <= 0) delete cart[k];
  else cart[k] = next;
  persistCart();
  renderCart();
  updateCardAddButton(k);
}
function setCartQty(key, qty) {
  const k = normalizeKey(key);
  const item = items.get(k);
  if (!item) return;
  const stock = Math.max(0, parseInt0(item.qty));
  let n = Math.max(0, Math.min(stock, parseInt0(qty)));
  if (n <= 0) delete cart[k];
  else cart[k] = n;
  persistCart();
  renderCart();
  updateCardAddButton(k);
}
function removeFromCart(key) {
  const k = normalizeKey(key);
  delete cart[k];
  persistCart();
  renderCart();
  updateCardAddButton(k);
}
function clearCart() {
  const keys = Object.keys(cart);
  cart = {};
  persistCart();
  renderCart();
  for (const k of keys) updateCardAddButton(k);
}

function updateCardAddButton(key) {
  if (!els.cardGrid) return;
  const k = normalizeKey(key);
  const selector = `.market-card[data-key="${CSS && CSS.escape ? CSS.escape(k) : k}"]`;
  const card = els.cardGrid.querySelector(selector);
  if (!card) return;
  const oldBtn = card.querySelector(".market-card-add");
  if (!oldBtn) return;
  const item = items.get(k);
  if (!item) return;
  const stock = Math.max(0, parseInt0(item.qty));
  const cartQty = getCartQty(k);
  let html;
  if (stock <= 0) {
    html = `<button class="market-card-add" type="button" disabled>품절</button>`;
  } else if (cartQty > 0) {
    const cartFull = cartQty >= stock;
    html = `<button class="market-card-add added" type="button" data-cart-act="add" data-key="${escapeAttr(k)}" ${cartFull ? "disabled" : ""}>담김 (${cartQty})</button>`;
  } else {
    html = `<button class="market-card-add" type="button" data-cart-act="add" data-key="${escapeAttr(k)}">담기</button>`;
  }
  oldBtn.outerHTML = html;
}

function renderCart() {
  if (!els.cartFab) return;
  const count = cartCount();
  els.cartFab.hidden = count === 0;
  if (els.cartFabCount) els.cartFabCount.textContent = count.toLocaleString("ko-KR");

  const body = els.cartDrawerBody;
  if (!body) return;
  body.innerHTML = "";
  let totalQty = 0;
  let totalValue = 0;
  const entries = Object.entries(cart);
  if (entries.length === 0) {
    body.innerHTML = `<p class="empty">장바구니가 비어 있습니다.</p>`;
  } else {
    for (const [key, qty] of entries) {
      const item = items.get(key);
      if (!item) {
        const row = document.createElement("div");
        row.className = "cart-item missing";
        row.innerHTML = `
          <div class="cart-item-info">
            <div class="cart-item-name">삭제된 카드</div>
            <div class="cart-item-no">${escapeHTML(key)}</div>
          </div>
          <button class="icon-btn danger" data-cart-act="remove" data-key="${escapeAttr(key)}">×</button>
        `;
        body.appendChild(row);
        continue;
      }
      const stock = Math.max(0, parseInt0(item.qty));
      const eff = getEffectivePrice(item);
      const orig = parseInt0(item.value);
      const hasDiscount = eff < orig;
      const lineTotal = qty * eff;
      totalQty += qty;
      totalValue += lineTotal;
      const row = document.createElement("div");
      row.className = "cart-item";
      row.dataset.key = key;
      const thumb = item.imageUrl
        ? `<img class="cart-item-thumb" src="${escapeAttr(item.imageUrl)}${item.imageUpdatedAt ? `?t=${item.imageUpdatedAt}` : ""}" alt="" loading="lazy" />`
        : `<div class="cart-item-thumb empty">—</div>`;
      const priceLine = hasDiscount
        ? `<span class="cart-item-percent">${item.discount.percent}%</span> <s>${formatWon(orig)}</s> ${formatWon(eff)}`
        : `${formatWon(eff)}`;
      row.innerHTML = `
        ${thumb}
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHTML(item.name || "이름 미등록")}</div>
          <div class="cart-item-no">${escapeHTML(item.no)} · ${priceLine}</div>
        </div>
        <div class="cart-item-qty">
          <button class="icon-btn" data-cart-act="dec" data-key="${escapeAttr(key)}" type="button">−</button>
          <input type="number" class="cart-qty-input" data-key="${escapeAttr(key)}" min="0" max="${stock}" value="${qty}" aria-label="수량" />
          <button class="icon-btn" data-cart-act="inc" data-key="${escapeAttr(key)}" type="button">+</button>
        </div>
        <button class="icon-btn danger cart-item-remove" data-cart-act="remove" data-key="${escapeAttr(key)}" type="button" aria-label="삭제">×</button>
      `;
      body.appendChild(row);
    }
  }
  if (els.cartTotalQty) els.cartTotalQty.textContent = totalQty.toLocaleString("ko-KR");
  if (els.cartTotalValue) els.cartTotalValue.textContent = formatWon(totalValue);
  if (els.cartSubmit) els.cartSubmit.disabled = totalQty === 0;
}

function openCartDrawer() {
  els.cartDrawer.hidden = false;
  els.cartBackdrop.hidden = false;
  document.body.classList.add("drawer-open");
}
function closeCartDrawer() {
  els.cartDrawer.hidden = true;
  els.cartBackdrop.hidden = true;
  document.body.classList.remove("drawer-open");
}

// ---------- Purchase request ----------
const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 0,O,1,I,L 제외
function generateCode(len = 5) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return s;
}

async function submitPurchaseRequest() {
  const entries = Object.entries(cart);
  if (entries.length === 0) {
    showToast("장바구니가 비어 있습니다.", "error");
    return;
  }
  const cartItems = [];
  let totalQty = 0;
  let totalValue = 0;
  for (const [key, qty] of entries) {
    const item = items.get(key);
    if (!item || qty <= 0) continue;
    const eff = getEffectivePrice(item);
    const discountSnap = isDiscountActive(item.discount)
      ? {
          percent: item.discount.percent,
          startsAt: item.discount.startsAt || null,
          endsAt: item.discount.endsAt || null,
        }
      : null;
    cartItems.push({
      key,
      no: item.no,
      name: item.name || "",
      qty,
      value: item.value || 0,
      effectivePrice: eff,
      discount: discountSnap,
      state: item.state == null ? null : item.state,
      grade: item.grade || "",
      imageUrl: item.imageUrl || "",
    });
    totalQty += qty;
    totalValue += qty * eff;
  }
  if (cartItems.length === 0) {
    showToast("유효한 카드가 없습니다.", "error");
    return;
  }
  if (els.cartSubmit) els.cartSubmit.disabled = true;
  showToast("요청 코드 생성 중…");

  let success = false;
  let lastErr = null;
  let code = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    code = generateCode(5);
    try {
      await setDoc(doc(db, "requests", code), {
        code,
        items: cartItems,
        totalQty,
        totalValue,
        status: "pending",
        createdAt: serverTimestamp(),
      });
      success = true;
      break;
    } catch (e) {
      lastErr = e;
      if (e && e.code === "permission-denied") {
        // collision (existing doc cannot be updated by anonymous) → retry with new code
        continue;
      }
      break;
    }
  }
  if (els.cartSubmit) els.cartSubmit.disabled = cartCount() === 0;
  if (!success) {
    showToast("요청 전송 실패: " + ((lastErr && lastErr.message) || "잠시 후 다시 시도해 주세요."), "error");
    return;
  }
  clearCart();
  closeCartDrawer();
  openCodeModal(code, totalQty, totalValue);
}

function openCodeModal(code, totalQty, totalValue) {
  els.codeDisplay.textContent = code;
  if (els.codeModalMeta) {
    els.codeModalMeta.textContent = `총 ${totalQty}장 · ${formatWon(totalValue)}`;
  }
  els.codeModal.hidden = false;
  document.body.classList.add("modal-open");
}
function closeCodeModal() {
  els.codeModal.hidden = true;
  document.body.classList.remove("modal-open");
}

// ---------- Admin: lookup & process request ----------
async function lookupRequest(rawCode) {
  if (!isOwner(currentUser)) return;
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) {
    showToast("코드를 입력하세요.", "error");
    return;
  }
  els.requestResult.innerHTML = `<p class="empty">조회 중…</p>`;
  try {
    const snap = await getDoc(doc(db, "requests", code));
    if (!snap.exists()) {
      els.requestResult.innerHTML = `<p class="empty">해당 코드의 요청이 없습니다.</p>`;
      lastRequest = null;
      return;
    }
    const data = snap.data();
    lastRequest = { code, data };
    renderRequestResult(code, data);
  } catch (e) {
    console.error("lookupRequest failed", e);
    els.requestResult.innerHTML = `<p class="empty">조회 실패: ${escapeHTML(e.message || String(e))}</p>`;
  }
}

function renderRequestResult(code, data) {
  const status = data.status || "pending";
  const statusLabel = { pending: "대기 중", completed: "판매 완료", cancelled: "취소" }[status] || status;
  const created = data.createdAt && data.createdAt.toDate ? data.createdAt.toDate() : null;
  const reqItems = Array.isArray(data.items) ? data.items : [];

  const stockWarning = [];
  const rows = reqItems.map((it) => {
    const cur = items.get(normalizeKey(it.key));
    const stock = cur ? parseInt0(cur.qty) : 0;
    const insufficient = stock < (it.qty || 0);
    if (insufficient) stockWarning.push(`${it.no} (요청 ${it.qty} / 재고 ${stock})`);
    const stateBadge = it.state != null
      ? `<span class="state-badge ${stateClass(it.state)}">${escapeHTML(String(it.state))}</span>`
      : "";
    const orig = it.value || 0;
    const linePrice = it.effectivePrice != null ? it.effectivePrice : orig;
    const lineTotal = linePrice * (it.qty || 0);
    const discountTag = it.discount && it.discount.percent
      ? ` <span class="discount-tag">${it.discount.percent}% 할인</span>`
      : "";
    const priceCell = linePrice !== orig
      ? `<s>${formatWon(orig)}</s> ${formatWon(linePrice)}`
      : formatWon(orig);
    return `
      <tr>
        <td class="mono">${escapeHTML(it.no)}</td>
        <td>${escapeHTML(it.name || "")}${cur ? "" : ' <span class="missing-tag">삭제됨</span>'}${discountTag}</td>
        <td>${stateBadge}</td>
        <td class="num">${priceCell}</td>
        <td class="num">${(it.qty || 0).toLocaleString("ko-KR")}${insufficient ? ` <span class="missing-tag">재고 ${stock}</span>` : ""}</td>
        <td class="num">${formatWon(lineTotal)}</td>
      </tr>
    `;
  }).join("");

  const canComplete = status === "pending" && stockWarning.length === 0 && reqItems.length > 0;
  const actions = status === "pending"
    ? `
      <button class="btn btn-primary" id="request-complete" type="button" ${canComplete ? "" : "disabled"}>판매 완료 처리</button>
      <button class="btn btn-danger" id="request-cancel" type="button">거절</button>
    `
    : `<span class="data-status">처리 완료된 요청입니다.</span>`;

  els.requestResult.innerHTML = `
    <div class="request-summary">
      <div class="request-summary-head">
        <span class="request-code">${escapeHTML(code)}</span>
        <span class="request-status request-status-${status}">${statusLabel}</span>
        ${created ? `<span class="request-time">${created.toLocaleString("ko-KR")}</span>` : ""}
      </div>
      ${stockWarning.length > 0 ? `<div class="request-warning">⚠️ 재고 부족: ${escapeHTML(stockWarning.join(", "))}</div>` : ""}
      <div class="table-wrap">
        <table class="request-table">
          <thead>
            <tr>
              <th>일련번호</th>
              <th>카드명</th>
              <th>상태</th>
              <th class="num">단가</th>
              <th class="num">수량</th>
              <th class="num">합계</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td colspan="4" class="num"><strong>합계</strong></td>
              <td class="num"><strong>${(data.totalQty || 0).toLocaleString("ko-KR")}장</strong></td>
              <td class="num"><strong>${formatWon(data.totalValue || 0)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="request-actions">${actions}</div>
    </div>
  `;

  const completeBtn = document.getElementById("request-complete");
  const cancelBtn = document.getElementById("request-cancel");
  if (completeBtn) completeBtn.addEventListener("click", () => completeRequest(code, data));
  if (cancelBtn) cancelBtn.addEventListener("click", () => cancelRequest(code));
}

async function completeRequest(code, data) {
  if (!isOwner(currentUser)) return;
  const reqItems = Array.isArray(data.items) ? data.items : [];
  for (const it of reqItems) {
    const cur = items.get(normalizeKey(it.key));
    const stock = cur ? parseInt0(cur.qty) : 0;
    if (!cur) {
      showToast(`삭제된 카드: ${it.no}`, "error");
      return;
    }
    if (stock < (it.qty || 0)) {
      showToast(`재고 부족: ${it.no} (요청 ${it.qty} / 재고 ${stock})`, "error");
      return;
    }
  }
  if (!confirm(`총 ${data.totalQty}장 / ${formatWon(data.totalValue)} 판매로 처리할까요? 재고가 차감됩니다.`)) return;
  try {
    for (const it of reqItems) {
      const k = normalizeKey(it.key);
      const cur = items.get(k);
      if (!cur) continue;
      const newQty = Math.max(0, parseInt0(cur.qty) - (it.qty || 0));
      items.set(k, { ...cur, qty: newQty });
    }
    await saveInventory();
    await setDoc(doc(db, "requests", code), {
      status: "completed",
      completedAt: serverTimestamp(),
      completedBy: currentUser.email || null,
    }, { merge: true });
    showToast(`${code} 요청 판매 처리 완료`, "success");
    await lookupRequest(code);
    renderAll();
  } catch (e) {
    console.error("completeRequest failed", e);
    showToast("처리 실패: " + (e.message || e), "error");
  }
}

async function cancelRequest(code) {
  if (!isOwner(currentUser)) return;
  if (!confirm(`${code} 요청을 거절(취소) 처리할까요? 재고는 변하지 않습니다.`)) return;
  try {
    await setDoc(doc(db, "requests", code), {
      status: "cancelled",
      cancelledAt: serverTimestamp(),
      cancelledBy: currentUser.email || null,
    }, { merge: true });
    showToast(`${code} 요청 거절 처리`, "success");
    await lookupRequest(code);
  } catch (e) {
    console.error("cancelRequest failed", e);
    showToast("처리 실패: " + (e.message || e), "error");
  }
}

// ---------- Mutations ----------
async function upsertCard({ no, name, grade, state, value, qty }, mode = "merge") {
  if (!isOwner(currentUser)) {
    showToast("관리자 로그인이 필요합니다.", "error");
    return { ok: false, msg: "권한 없음" };
  }
  const trimmedNo = String(no || "").trim();
  const key = normalizeKey(trimmedNo);
  if (!key) return { ok: false, msg: "일련번호를 입력하세요." };
  const existing = items.get(key);
  const incomingState = state != null && state !== "" ? normalizeState(state) : null;
  const next = {
    ...(existing || {}),
    no: trimmedNo,
    name: name != null && name !== "" ? String(name).trim() : (existing ? existing.name : ""),
    grade: grade != null && grade !== "" ? normalizeGrade(grade) : (existing ? existing.grade : ""),
    state: incomingState != null ? incomingState : (existing ? (existing.state ?? null) : "S"),
    value: value != null && value !== "" ? parseInt0(value) : (existing ? existing.value : 0),
    qty: 0,
  };
  const incomingQty = Math.max(0, parseInt0(qty) || 0);
  if (mode === "merge") {
    next.qty = (existing ? Math.max(0, parseInt0(existing.qty)) : 0) + incomingQty;
  } else {
    next.qty = incomingQty;
  }
  items.set(key, next);
  renderAll();
  await saveInventory();
  return { ok: true, item: next, wasNew: !existing };
}

async function updateField(key, field, raw) {
  if (!isOwner(currentUser)) return;
  const k = normalizeKey(key);
  const entry = items.get(k);
  if (!entry) return;
  const next = { ...entry };
  if (field === "name") next.name = String(raw || "").trim();
  else if (field === "grade") next.grade = normalizeGrade(raw);
  else if (field === "state") next.state = (raw === "" || raw == null) ? null : normalizeState(raw);
  else if (field === "value") next.value = Math.max(0, parseInt0(raw));
  else if (field === "qty") {
    next.qty = Math.max(0, parseInt0(raw));
  } else return;
  items.set(k, next);
  renderAll();
  await saveInventory();
}

async function adjustQty(key, delta) {
  if (!isOwner(currentUser)) return;
  const k = normalizeKey(key);
  const entry = items.get(k);
  if (!entry) return;
  const q = Math.max(0, (parseInt0(entry.qty) || 0) + delta);
  items.set(k, { ...entry, qty: q });
  renderAll();
  await saveInventory();
}

async function removeCard(key) {
  if (!isOwner(currentUser)) return;
  items.delete(normalizeKey(key));
  renderAll();
  await saveInventory();
}

// ---------- Auth handlers ----------
function shouldUseAuthRedirect() {
  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|Edg|OPR/.test(ua);
  // 모바일 또는 Safari는 popup이 자주 막혀서 redirect 사용
  return isIOS || isAndroid || isSafari;
}

async function handleLogin() {
  try {
    setSyncStatus("connecting", "로그인 중…");
    if (shouldUseAuthRedirect()) {
      await signInWithRedirect(auth, googleProvider);
      // 페이지가 Google로 이동했다가 돌아옴 — 이후 코드 실행 안 됨
    } else {
      await signInWithPopup(auth, googleProvider);
    }
  } catch (err) {
    console.error("login failed", err);
    refreshSyncStatus();
    if (err && err.code === "auth/popup-closed-by-user") return;
    if (err && err.code === "auth/cancelled-popup-request") return;
    showToast("로그인 실패: " + (err.message || err), "error");
  }
}

async function handleLogout() {
  try {
    await signOut(auth);
    showToast("로그아웃되었습니다.", "success");
  } catch (err) {
    console.error("logout failed", err);
    showToast("로그아웃 실패: " + (err.message || err), "error");
  }
}

// ---------- Suggestions ----------
let suggestionIndex = -1;
function showSuggestions(query) {
  const q = String(query || "").trim().toLowerCase();
  const list = els.suggestions;
  list.innerHTML = "";
  suggestionIndex = -1;
  if (!q || items.size === 0) {
    list.classList.add("hidden");
    return;
  }
  const matches = [];
  for (const [, v] of items) {
    if (
      v.no.toLowerCase().includes(q) ||
      (v.name || "").toLowerCase().includes(q)
    ) {
      matches.push(v);
      if (matches.length >= 8) break;
    }
  }
  if (matches.length === 0) {
    list.classList.add("hidden");
    return;
  }
  for (const m of matches) {
    const li = document.createElement("li");
    li.dataset.no = m.no;
    li.innerHTML = `
      <span><span class="no">${escapeHTML(m.no)}</span> &nbsp; ${escapeHTML(m.name || "")}</span>
      <span class="meta">${m.state != null ? `<span class="state-badge ${stateClass(m.state)}">${escapeHTML(String(m.state))}</span>` : ""} ${formatWon(m.value || 0)}</span>
    `;
    list.appendChild(li);
  }
  list.classList.remove("hidden");
}

function moveSuggestion(delta) {
  const list = Array.from(els.suggestions.querySelectorAll("li"));
  if (list.length === 0) return;
  suggestionIndex = (suggestionIndex + delta + list.length) % list.length;
  list.forEach((it, i) => it.classList.toggle("active", i === suggestionIndex));
  list[suggestionIndex].scrollIntoView({ block: "nearest" });
}

// ---------- Export ----------
function exportCSV() {
  if (items.size === 0) {
    showToast("내보낼 데이터가 없습니다.", "error");
    return;
  }
  const rows = [["일련번호", "카드명", "등급", "상태", "가치", "보유 수량", "합계"]];
  let total = 0;
  const sorted = Array.from(items.values()).sort((a, b) =>
    a.no.localeCompare(b.no, "ko", { numeric: true }),
  );
  for (const r of sorted) {
    const sum = (r.qty || 0) * (r.value || 0);
    total += sum;
    rows.push([r.no, r.name, r.grade, r.state == null ? "" : r.state, r.value, r.qty, sum]);
  }
  rows.push(["", "", "", "", "", "합계", total]);
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pokemon-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- Wiring ----------
els.csvFile.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importFromText(String(reader.result || ""));
    els.csvFile.value = "";
  };
  reader.readAsText(file, "utf-8");
});

els.pasteToggle.addEventListener("click", () => {
  els.pasteArea.classList.toggle("hidden");
  if (!els.pasteArea.classList.contains("hidden")) els.pasteInput.focus();
});
els.pasteApply.addEventListener("click", () => {
  importFromText(els.pasteInput.value);
  els.pasteInput.value = "";
  els.pasteArea.classList.add("hidden");
});
els.pasteCancel.addEventListener("click", () => {
  els.pasteInput.value = "";
  els.pasteArea.classList.add("hidden");
});

els.addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const no = els.cardNo.value.trim();
  const name = els.cardName.value.trim();
  const grade = els.cardGrade.value;
  const state = els.cardState.value;
  const value = els.cardValue.value;
  const qty = Math.max(1, parseInt(els.cardQty.value, 10) || 1);
  if (!no) return;
  const result = await upsertCard({ no, name, grade, state, value, qty }, "merge");
  if (result.ok) {
    showToast(
      result.wasNew ? `추가됨: ${result.item.no}` : `수량 업데이트: ${result.item.no} (${result.item.qty}장)`,
      "success",
    );
    els.cardNo.value = "";
    els.cardName.value = "";
    els.cardGrade.value = "";
    els.cardState.value = "S";
    els.cardValue.value = "";
    els.cardQty.value = "1";
    els.suggestions.classList.add("hidden");
    els.cardPreview.textContent = "";
    els.cardPreview.classList.remove("found", "error");
    els.cardNo.focus();
  }
});

els.cardNo.addEventListener("input", (e) => {
  const v = e.target.value;
  showSuggestions(v);
  const key = normalizeKey(v);
  const existing = key ? items.get(key) : null;
  if (existing) {
    els.cardPreview.textContent = `이미 등록된 카드: ${existing.no} ${existing.name || ""} (현재 ${existing.qty}장) — 수량이 합산됩니다.`;
    els.cardPreview.classList.add("found");
    els.cardPreview.classList.remove("error");
  } else {
    els.cardPreview.textContent = "";
    els.cardPreview.classList.remove("found", "error");
  }
});
els.cardNo.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); moveSuggestion(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveSuggestion(-1); }
  else if (e.key === "Enter" && suggestionIndex >= 0) {
    e.preventDefault();
    const list = Array.from(els.suggestions.querySelectorAll("li"));
    if (list[suggestionIndex]) {
      const no = list[suggestionIndex].dataset.no;
      els.cardNo.value = no;
      els.suggestions.classList.add("hidden");
      const existing = items.get(normalizeKey(no));
      if (existing) {
        els.cardName.value = existing.name || "";
        els.cardGrade.value = existing.grade || "";
        els.cardState.value = existing.state == null ? "" : String(existing.state);
        els.cardValue.value = existing.value || "";
      }
      els.cardQty.focus();
    }
  } else if (e.key === "Escape") {
    els.suggestions.classList.add("hidden");
  }
});
els.cardNo.addEventListener("blur", () => {
  setTimeout(() => els.suggestions.classList.add("hidden"), 150);
});
els.suggestions.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  e.preventDefault();
  const no = li.dataset.no;
  els.cardNo.value = no;
  els.suggestions.classList.add("hidden");
  const existing = items.get(normalizeKey(no));
  if (existing) {
    els.cardName.value = existing.name || "";
    els.cardGrade.value = existing.grade || "";
    els.cardValue.value = existing.value || "";
  }
  els.cardQty.focus();
});

els.inventoryBody.addEventListener("click", async (e) => {
  const tr = e.target.closest("tr[data-key]");
  if (!tr) return;
  const key = tr.dataset.key;

  // Image actions: view available to everyone, upload/delete admin only
  const imgAct = e.target.closest("[data-img-action]");
  if (imgAct) {
    e.stopPropagation();
    const action = imgAct.dataset.imgAction;
    if (action === "view") {
      const entry = items.get(normalizeKey(key));
      if (entry && entry.imageUrl) openLightbox(entry.imageUrl);
      return;
    }
    if (!isOwner(currentUser)) return;
    if (action === "upload") {
      currentUploadKey = key;
      els.imageInput.value = "";
      els.imageInput.click();
    } else if (action === "delete") {
      await deleteCardImage(key);
    }
    return;
  }

  if (!isOwner(currentUser)) return;
  const dBtn = e.target.closest("[data-discount-btn]");
  if (dBtn) {
    openDiscountModal(key);
    return;
  }
  const actBtn = e.target.closest("[data-act]");
  if (actBtn) {
    const act = actBtn.dataset.act;
    if (act === "inc") await adjustQty(key, 1);
    else if (act === "dec") await adjustQty(key, -1);
    else if (act === "remove") {
      if (confirm("이 카드를 목록에서 삭제할까요?")) await removeCard(key);
    }
    return;
  }
  const editEl = e.target.closest(".cell-edit");
  if (editEl && !editEl.isContentEditable) {
    startInlineEdit(editEl, tr, "name");
  }
});

els.inventoryBody.addEventListener("keydown", (e) => {
  if (!isOwner(currentUser)) return;
  const editEl = e.target.closest(".cell-edit");
  if (editEl && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    const tr = editEl.closest("tr[data-key]");
    if (tr) startInlineEdit(editEl, tr, "name");
  }
});

function startInlineEdit(span, tr, field) {
  const key = tr.dataset.key;
  const entry = items.get(normalizeKey(key));
  const current = entry ? (entry[field] || "") : "";
  span.contentEditable = "true";
  span.classList.add("editing");
  span.textContent = current;
  const range = document.createRange();
  range.selectNodeContents(span);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  span.focus();

  const finish = async (commit) => {
    span.removeEventListener("blur", onBlur);
    span.removeEventListener("keydown", onKey);
    span.contentEditable = "false";
    span.classList.remove("editing");
    if (commit) {
      const v = span.textContent.trim();
      await updateField(key, field, v);
    } else {
      renderAll();
    }
  };
  const onBlur = () => finish(true);
  const onKey = (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
  };
  span.addEventListener("blur", onBlur);
  span.addEventListener("keydown", onKey);
}

els.inventoryBody.addEventListener("change", async (e) => {
  if (!isOwner(currentUser)) return;
  const tr = e.target.closest("tr[data-key]");
  if (!tr) return;
  const key = tr.dataset.key;
  const target = e.target;
  if (target.matches(".state-input")) {
    await updateField(key, "state", target.value);
  } else if (target.matches(".value-input")) {
    await updateField(key, "value", target.value);
  } else if (target.matches(".qty-input")) {
    await updateField(key, "qty", target.value);
  }
});

els.inventoryTable.querySelectorAll("th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = -sortDir;
    else { sortKey = k; sortDir = 1; }
    renderInventory();
  });
});

if (els.cardGrid) {
  els.cardGrid.addEventListener("click", (e) => {
    const cartBtn = e.target.closest("[data-cart-act='add']");
    if (cartBtn) {
      e.stopPropagation();
      addToCart(cartBtn.dataset.key, 1);
      return;
    }
    const card = e.target.closest(".market-card[data-key]");
    if (!card) return;
    const entry = items.get(normalizeKey(card.dataset.key));
    if (entry && entry.imageUrl) openLightbox(entry.imageUrl);
  });
}

// Cart drawer interactions
if (els.cartFab) els.cartFab.addEventListener("click", openCartDrawer);
if (els.cartDrawerClose) els.cartDrawerClose.addEventListener("click", closeCartDrawer);
if (els.cartBackdrop) els.cartBackdrop.addEventListener("click", closeCartDrawer);
if (els.cartClear) els.cartClear.addEventListener("click", () => {
  if (cartCount() === 0) return;
  if (confirm("장바구니를 비울까요?")) clearCart();
});
if (els.cartSubmit) els.cartSubmit.addEventListener("click", submitPurchaseRequest);
if (els.cartDrawerBody) {
  els.cartDrawerBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cart-act]");
    if (!btn) return;
    const key = btn.dataset.key;
    const act = btn.dataset.cartAct;
    if (act === "inc") addToCart(key, 1);
    else if (act === "dec") addToCart(key, -1);
    else if (act === "remove") removeFromCart(key);
  });
  els.cartDrawerBody.addEventListener("change", (e) => {
    const input = e.target.closest(".cart-qty-input");
    if (!input) return;
    setCartQty(input.dataset.key, input.value);
  });
}

// Code modal
if (els.codeClose) els.codeClose.addEventListener("click", closeCodeModal);
if (els.codeModalBackdrop) els.codeModalBackdrop.addEventListener("click", closeCodeModal);
if (els.codeCopy) els.codeCopy.addEventListener("click", async () => {
  const code = els.codeDisplay.textContent.trim();
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    showToast("코드가 복사되었습니다.", "success");
  } catch (e) {
    showToast("복사 실패. 직접 선택해 주세요.", "error");
  }
});

// Admin: request lookup
if (els.requestForm) {
  els.requestForm.addEventListener("submit", (e) => {
    e.preventDefault();
    lookupRequest(els.requestCodeInput.value);
  });
}
if (els.requestCodeInput) {
  els.requestCodeInput.addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
}

if (els.sortSelect) {
  els.sortSelect.addEventListener("change", () => {
    const v = els.sortSelect.value;
    const [k, d] = v.split("|");
    sortKey = k;
    sortDir = parseInt(d, 10) || 1;
    renderInventory();
  });
}

els.gradeFilter.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  activeState = chip.dataset.state || "";
  renderAll();
});

els.inventorySearch.addEventListener("input", renderInventory);
els.exportBtn.addEventListener("click", exportCSV);
if (els.imagesClearBtn) {
  els.imagesClearBtn.addEventListener("click", bulkRemoveImages);
}
els.inventoryClear.addEventListener("click", async () => {
  if (!isOwner(currentUser)) return;
  if (items.size === 0) return;
  if (!confirm(`전체 인벤토리(${items.size}건)를 삭제할까요? 되돌릴 수 없습니다.`)) return;
  items = new Map();
  renderAll();
  await saveInventory();
});

els.imageInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  const key = currentUploadKey;
  currentUploadKey = null;
  e.target.value = "";
  if (!file || !key) return;
  await uploadCardImage(key, file);
});

els.lightboxBackdrop.addEventListener("click", closeLightbox);
els.lightboxClose.addEventListener("click", closeLightbox);
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!els.lightbox.hidden) { closeLightbox(); return; }
  if (els.discountModal && !els.discountModal.hidden) { closeDiscountModal(); return; }
  if (els.codeModal && !els.codeModal.hidden) { closeCodeModal(); return; }
  if (els.cartDrawer && !els.cartDrawer.hidden) { closeCartDrawer(); return; }
});

// Discount modal
if (els.discountForm) {
  els.discountForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentDiscountKey) return;
    const percent = parseInt(els.discountPercent.value, 10);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      showToast("할인율을 1-100 사이로 입력하세요.", "error");
      return;
    }
    const startsAt = localInputToISO(els.discountStart.value);
    const endsAt = localInputToISO(els.discountEnd.value);
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
      showToast("종료 일시가 시작 일시보다 늦어야 합니다.", "error");
      return;
    }
    const discount = { percent };
    if (startsAt) discount.startsAt = startsAt;
    if (endsAt) discount.endsAt = endsAt;
    const key = currentDiscountKey;
    closeDiscountModal();
    await persistDiscount(key, discount);
    showToast(`${percent}% 할인이 저장되었습니다.`, "success");
  });
}
if (els.discountRemove) {
  els.discountRemove.addEventListener("click", async () => {
    if (!currentDiscountKey) return;
    if (!confirm("이 카드의 할인을 제거할까요?")) return;
    const key = currentDiscountKey;
    closeDiscountModal();
    await persistDiscount(key, null);
    showToast("할인이 제거되었습니다.", "success");
  });
}
if (els.discountCancel) els.discountCancel.addEventListener("click", closeDiscountModal);
if (els.discountModalBackdrop) els.discountModalBackdrop.addEventListener("click", closeDiscountModal);

// 할인율 ↔ 할인 후 금액 양방향 동기화
if (els.discountPercent) {
  els.discountPercent.addEventListener("input", () => {
    if (discountSyncing) return;
    if (currentDiscountOriginal <= 0) return;
    const p = parseFloat(els.discountPercent.value);
    if (!Number.isFinite(p)) { els.discountFinal.value = ""; return; }
    discountSyncing = true;
    els.discountFinal.value = Math.max(0, Math.round((currentDiscountOriginal * (100 - p)) / 100));
    discountSyncing = false;
  });
}
if (els.discountFinal) {
  els.discountFinal.addEventListener("input", () => {
    if (discountSyncing) return;
    if (currentDiscountOriginal <= 0) return;
    const f = parseFloat(els.discountFinal.value);
    if (!Number.isFinite(f)) { els.discountPercent.value = ""; return; }
    const clamped = Math.max(0, Math.min(currentDiscountOriginal, f));
    const p = Math.round(((currentDiscountOriginal - clamped) / currentDiscountOriginal) * 100);
    discountSyncing = true;
    els.discountPercent.value = Math.max(0, Math.min(100, p));
    discountSyncing = false;
  });
}

// Image auto-format toggle
if (els.imageFormatOn) {
  els.imageFormatOn.checked = imageAutoFormat;
  els.imageFormatOn.addEventListener("change", (e) => {
    imageAutoFormat = !!e.target.checked;
    try { localStorage.setItem("pokemon_image_auto_format", imageAutoFormat ? "1" : "0"); } catch (err) {}
    showToast(
      imageAutoFormat
        ? "사진 업로드 시 자동 정렬이 켜졌습니다."
        : "사진 업로드 시 자동 정렬이 꺼졌습니다.",
      "success",
    );
  });
}

// Sets (확장팩 라벨)
if (els.setsForm) {
  els.setsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isOwner(currentUser)) return;
    await upsertSet(els.setPrefix.value, els.setName.value);
    els.setPrefix.value = "";
    els.setName.value = "";
    els.setPrefix.focus();
  });
}
if (els.setsList) {
  els.setsList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-set-remove]");
    if (!btn) return;
    removeSet(btn.dataset.setRemove);
  });
}

// Hidden admin login: 3연속 클릭 on PokeStock 로고
const brandBtn = $("brand-btn");
let brandClicks = [];
if (brandBtn) {
  brandBtn.addEventListener("click", () => {
    if (currentUser) return;
    const now = Date.now();
    brandClicks = brandClicks.filter((t) => now - t < 1500);
    brandClicks.push(now);
    if (brandClicks.length >= 3) {
      brandClicks = [];
      handleLogin();
    }
  });
}

window.addEventListener("online", refreshSyncStatus);
window.addEventListener("offline", () => setSyncStatus("offline"));

// ---------- Auth bootstrap ----------
setSyncStatus("connecting");
renderAuthArea();
applyOwnerMode();

// signInWithRedirect 후 페이지 복귀 처리 (모바일/Safari 경로)
getRedirectResult(auth).catch((err) => {
  console.error("redirect result error", err);
  if (err && err.code) {
    showToast("로그인 실패: " + (err.message || err.code), "error");
  }
});

onAuthStateChanged(auth, (user) => {
  currentUser = user || null;
  applyOwnerMode();
  refreshSyncStatus();
  // Re-attach listener (rules differ for authenticated vs anonymous reads,
  // and we want to re-trigger migration on first owner login).
  attachInventoryListener();
  if (user && isOwner(user) && initialLoaded && items.size === 0) {
    migrationAttempted = false;
    maybeMigrate();
  }
});

// Initial public read attempt even before auth state resolves.
attachInventoryListener();
attachSetsListener();
renderAll();
renderCart();
renderSets();
