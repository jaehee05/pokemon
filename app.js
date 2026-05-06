import { auth, db, storage, googleProvider, OWNER_EMAILS } from "./firebase.js";
import {
  signInWithPopup,
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

let inventoryUnsub = null;
let initialLoaded = false;
let migrationAttempted = false;

let pendingSaves = 0;
let savingTimer = null;

let sortKey = "no";
let sortDir = 1; // 1 asc, -1 desc
let activeGrade = "";

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
  cardValue: $("card-value"),
  cardQty: $("card-qty"),
  cardPreview: $("card-preview"),
  suggestions: $("suggestions"),

  inventoryBody: $("inventory-body"),
  inventoryEmpty: $("inventory-empty"),
  inventorySearch: $("inventory-search"),
  inventoryClear: $("inventory-clear"),
  inventoryCount: $("inventory-count"),
  inventoryTable: $("inventory-table"),
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
};

let currentUploadKey = null;

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
    /일련번호|번호|카드|등급|가치|가격|수량|보유|name|grade|value|price|qty/i.test(String(h)),
  );
  if (!looksLikeHeader) {
    header = ["일련번호", "카드명", "등급", "가치", "보유 수량"];
    dataRows = rows;
  }

  const noIdx = findColumnIndex(header, ["일련번호", "번호", "no", "number", "code"]);
  const nameIdx = findColumnIndex(header, ["카드명", "이름", "name", "카드"]);
  const gradeIdx = findColumnIndex(header, ["등급", "grade", "rarity"]);
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
    const value = valueIdx >= 0 ? parseInt0(r[valueIdx]) : 0;
    const qty = qtyIdx >= 0 ? Math.max(0, parseInt0(r[qtyIdx])) : 1;

    const existing = next.get(key);
    if (existing) updated++;
    else added++;
    next.set(key, {
      no: no,
      name: name || (existing && existing.name) || "",
      grade: grade || (existing && existing.grade) || "",
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

function attachInventoryListener() {
  if (inventoryUnsub) inventoryUnsub();

  inventoryUnsub = onSnapshot(
    inventoryDocRef(),
    (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const obj = (data && data.items) || {};
      items = new Map(Object.entries(obj));
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
    area.innerHTML = `<button class="btn btn-light" id="login-btn" type="button">관리자</button>`;
    const loginBtn = document.getElementById("login-btn");
    if (loginBtn) loginBtn.addEventListener("click", handleLogin);
  }
}

function renderStats() {
  let totalQty = 0;
  let totalValue = 0;
  const byGrade = new Map();
  for (const [, v] of items) {
    const qty = Number(v.qty) || 0;
    const val = Number(v.value) || 0;
    totalQty += qty;
    totalValue += qty * val;
    const g = v.grade || "—";
    const cur = byGrade.get(g) || { types: 0, qty: 0 };
    cur.types += 1;
    cur.qty += qty;
    byGrade.set(g, cur);
  }
  els.statTypes.textContent = items.size.toLocaleString("ko-KR");
  els.statQty.textContent = totalQty.toLocaleString("ko-KR");
  els.statValue.textContent = formatWon(totalValue);

  const orderedGrades = Array.from(byGrade.keys()).sort((a, b) => {
    const ra = GRADE_RANK[a] != null ? GRADE_RANK[a] : 99;
    const rb = GRADE_RANK[b] != null ? GRADE_RANK[b] : 99;
    return ra - rb;
  });
  els.statGrades.innerHTML = "";
  for (const g of orderedGrades) {
    const stat = byGrade.get(g);
    const pill = document.createElement("div");
    pill.className = "grade-pill";
    pill.innerHTML = `
      <span class="grade-badge ${gradeClass(g)}">${escapeHTML(g)}</span>
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
  const presentGrades = new Set();
  for (const [, v] of items) presentGrades.add(v.grade || "");
  const grades = Array.from(presentGrades)
    .filter((g) => g !== "")
    .sort((a, b) => {
      const ra = GRADE_RANK[a] != null ? GRADE_RANK[a] : 99;
      const rb = GRADE_RANK[b] != null ? GRADE_RANK[b] : 99;
      return ra - rb;
    });

  container.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.className = "chip" + (activeGrade === "" ? " active" : "");
  allBtn.dataset.grade = "";
  allBtn.textContent = "전체";
  container.appendChild(allBtn);
  for (const g of grades) {
    const btn = document.createElement("button");
    btn.className = "chip" + (activeGrade === g ? " active" : "");
    btn.dataset.grade = g;
    btn.innerHTML = `<span class="grade-badge ${gradeClass(g)}">${escapeHTML(g)}</span>`;
    container.appendChild(btn);
  }
  if (presentGrades.has("")) {
    const btn = document.createElement("button");
    btn.className = "chip" + (activeGrade === "__none__" ? " active" : "");
    btn.dataset.grade = "__none__";
    btn.textContent = "등급 없음";
    container.appendChild(btn);
  }
}

function compareItems(a, b) {
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
    case "value":
      return ((a.value || 0) - (b.value || 0)) * dir || a.no.localeCompare(b.no, "ko", { numeric: true });
    case "qty":
      return ((a.qty || 0) - (b.qty || 0)) * dir || a.no.localeCompare(b.no, "ko", { numeric: true });
    case "total":
      return (((a.qty || 0) * (a.value || 0)) - ((b.qty || 0) * (b.value || 0))) * dir
        || a.no.localeCompare(b.no, "ko", { numeric: true });
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
  if (activeGrade === "__none__") {
    filtered = filtered.filter((r) => !r.grade);
  } else if (activeGrade) {
    filtered = filtered.filter((r) => r.grade === activeGrade);
  }
  if (q) {
    filtered = filtered.filter(
      (r) =>
        r.no.toLowerCase().includes(q) ||
        (r.name || "").toLowerCase().includes(q),
    );
  }

  for (const r of filtered) {
    const total = (r.qty || 0) * (r.value || 0);
    const tr = document.createElement("tr");
    tr.dataset.key = r.key;
    const thumbCell = thumbCellHTML(r, owner);
    if (owner) {
      tr.innerHTML = `
        <td class="thumb-cell">${thumbCell}</td>
        <td class="mono">${escapeHTML(r.no)}</td>
        <td><span class="cell-edit" data-field="name" tabindex="0">${escapeHTML(r.name || "")}<span class="cell-empty">${r.name ? "" : "이름 없음"}</span></span></td>
        <td>
          <select class="grade-select ${gradeClass(r.grade)}" data-field="grade" aria-label="등급">
            <option value="" ${!r.grade ? "selected" : ""}>—</option>
            ${["RR","SR","SAR","UR","AR","R","U","C"].map(g => `<option value="${g}" ${r.grade===g?"selected":""}>${g}</option>`).join("")}
            ${r.grade && !GRADE_ORDER.includes(r.grade) ? `<option value="${escapeAttr(r.grade)}" selected>${escapeHTML(r.grade)}</option>` : ""}
          </select>
        </td>
        <td class="num"><input type="number" class="value-input" data-field="value" min="0" step="100" value="${r.value || 0}" aria-label="가격" /></td>
        <td class="num">
          <div class="qty-cell">
            <button class="icon-btn" data-act="dec" title="−1">−</button>
            <input type="number" class="qty-input" data-field="qty" min="0" step="1" value="${r.qty || 0}" aria-label="재고" />
            <button class="icon-btn" data-act="inc" title="+1">+</button>
          </div>
        </td>
        <td class="num total-cell">${formatWon(total)}</td>
        <td><button class="icon-btn danger" data-act="remove" title="삭제">×</button></td>
      `;
    } else {
      tr.innerHTML = `
        <td class="thumb-cell">${thumbCell}</td>
        <td class="mono">${escapeHTML(r.no)}</td>
        <td>${escapeHTML(r.name || "") || '<span class="cell-empty">이름 없음</span>'}</td>
        <td>${r.grade ? `<span class="grade-badge ${gradeClass(r.grade)}">${escapeHTML(r.grade)}</span>` : '<span class="grade-badge g-none">—</span>'}</td>
        <td class="num">${formatWon(r.value || 0)}</td>
        <td class="num">${(r.qty || 0).toLocaleString("ko-KR")}</td>
        <td class="num total-cell">${formatWon(total)}</td>
      `;
    }
    tbody.appendChild(tr);
  }

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

async function uploadCardImage(key, file) {
  if (!isOwner(currentUser)) {
    showToast("관리자만 업로드할 수 있습니다.", "error");
    return;
  }
  const k = normalizeKey(key);
  const entry = items.get(k);
  if (!entry) return;
  showToast("이미지 업로드 중…");
  try {
    const blob = await resizeImage(file, 900, 0.85);
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

// ---------- Mutations ----------
async function upsertCard({ no, name, grade, value, qty }, mode = "merge") {
  if (!isOwner(currentUser)) {
    showToast("관리자 로그인이 필요합니다.", "error");
    return { ok: false, msg: "권한 없음" };
  }
  const trimmedNo = String(no || "").trim();
  const key = normalizeKey(trimmedNo);
  if (!key) return { ok: false, msg: "일련번호를 입력하세요." };
  const existing = items.get(key);
  const next = {
    no: trimmedNo,
    name: name != null && name !== "" ? String(name).trim() : (existing ? existing.name : ""),
    grade: grade != null && grade !== "" ? normalizeGrade(grade) : (existing ? existing.grade : ""),
    value: value != null && value !== "" ? parseInt0(value) : (existing ? existing.value : 0),
    qty: 0,
  };
  const incomingQty = Math.max(0, parseInt0(qty) || 0);
  if (mode === "merge") {
    next.qty = (existing ? Math.max(0, parseInt0(existing.qty)) : 0) + incomingQty;
  } else {
    next.qty = incomingQty;
  }
  if (next.qty <= 0 && mode === "set") {
    items.delete(key);
  } else {
    items.set(key, next);
  }
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
  else if (field === "value") next.value = Math.max(0, parseInt0(raw));
  else if (field === "qty") {
    const q = Math.max(0, parseInt0(raw));
    if (q === 0) {
      items.delete(k);
      renderAll();
      await saveInventory();
      return;
    }
    next.qty = q;
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
  if (q === 0) items.delete(k);
  else items.set(k, { ...entry, qty: q });
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
async function handleLogin() {
  try {
    setSyncStatus("connecting", "로그인 중…");
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    console.error("login failed", err);
    refreshSyncStatus();
    if (err && err.code === "auth/popup-closed-by-user") return;
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
      <span class="meta">${m.grade ? `<span class="grade-badge ${gradeClass(m.grade)}">${escapeHTML(m.grade)}</span>` : ""} ${formatWon(m.value || 0)}</span>
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
  const rows = [["일련번호", "카드명", "등급", "가치", "보유 수량", "합계"]];
  let total = 0;
  const sorted = Array.from(items.values()).sort((a, b) =>
    a.no.localeCompare(b.no, "ko", { numeric: true }),
  );
  for (const r of sorted) {
    const sum = (r.qty || 0) * (r.value || 0);
    total += sum;
    rows.push([r.no, r.name, r.grade, r.value, r.qty, sum]);
  }
  rows.push(["", "", "", "", "합계", total]);
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
  const value = els.cardValue.value;
  const qty = Math.max(1, parseInt(els.cardQty.value, 10) || 1);
  if (!no) return;
  const result = await upsertCard({ no, name, grade, value, qty }, "merge");
  if (result.ok) {
    showToast(
      result.wasNew ? `추가됨: ${result.item.no}` : `수량 업데이트: ${result.item.no} (${result.item.qty}장)`,
      "success",
    );
    els.cardNo.value = "";
    els.cardName.value = "";
    els.cardGrade.value = "";
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
  if (target.matches(".grade-select")) {
    await updateField(key, "grade", target.value);
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

els.gradeFilter.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  activeGrade = chip.dataset.grade || "";
  renderAll();
});

els.inventorySearch.addEventListener("input", renderInventory);
els.exportBtn.addEventListener("click", exportCSV);
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
  if (e.key === "Escape" && !els.lightbox.hidden) closeLightbox();
});

window.addEventListener("online", refreshSyncStatus);
window.addEventListener("offline", () => setSyncStatus("offline"));

// ---------- Auth bootstrap ----------
setSyncStatus("connecting");
renderAuthArea();
applyOwnerMode();

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
renderAll();
