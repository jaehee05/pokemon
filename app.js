import { auth, db } from "./firebase.js";
import {
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  doc,
  setDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

// ---------- State ----------
let userId = null;
let catalog = new Map();    // key -> { no, name, price }
let collection = new Map(); // key -> { no, name, price, qty }

let catalogUnsub = null;
let collectionUnsub = null;

let initialCatalogLoaded = false;
let initialCollectionLoaded = false;
let migrationAttempted = false;

let pendingSaves = 0;
let savingTimer = null;

const LEGACY_KEYS = {
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
  sampleLoad: $("sample-load"),
  dataClear: $("data-clear"),
  dataStatus: $("data-status"),

  addForm: $("add-form"),
  cardInput: $("card-input"),
  qtyInput: $("qty-input"),
  cardPreview: $("card-preview"),
  suggestions: $("suggestions"),

  collectionBody: $("collection-body"),
  collectionEmpty: $("collection-empty"),
  collectionSearch: $("collection-search"),
  collectionClear: $("collection-clear"),
  exportBtn: $("export-btn"),
  totalsCount: $("totals-count"),
  totalsSum: $("totals-sum"),

  catalogBody: $("catalog-body"),
  catalogSearch: $("catalog-search"),
  catalogCount: $("catalog-count"),

  syncBadge: $("sync-badge"),
  syncText: document.querySelector("#sync-badge .sync-text"),

  toast: $("toast"),
};

// ---------- Helpers ----------
function normalizeKey(s) {
  if (s == null) return "";
  return String(s).trim().toLowerCase().replace(/\s+/g, " ");
}
function formatPrice(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("ko-KR") + "원";
}
function parsePrice(raw) {
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
  }, 2200);
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
  const norm = header.map((h) => normalizeKey(h));
  for (const cand of candidates) {
    const idx = norm.findIndex((h) => h.includes(cand));
    if (idx !== -1) return idx;
  }
  return -1;
}

async function importCatalogFromText(text) {
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

  let header = rows[0].map((h) => normalizeKey(h));
  let dataRows = rows.slice(1);
  const looksLikeHeader = header.some((h) =>
    /번호|이름|가격|순번|name|price|no\.?$|number/i.test(h),
  );
  if (!looksLikeHeader) {
    header = ["순번", "번호", "카드 이름", "가격"];
    dataRows = rows;
  }

  const noIdx = findColumnIndex(header, ["번호", "no", "number", "code"]);
  const nameIdx = findColumnIndex(header, ["이름", "name", "카드"]);
  const priceIdx = findColumnIndex(header, ["가격", "price", "원"]);

  if (noIdx === -1 || priceIdx === -1) {
    showToast("번호/가격 열을 찾을 수 없습니다. 헤더를 확인해주세요.", "error");
    return;
  }

  const next = new Map();
  for (const r of dataRows) {
    const no = (r[noIdx] || "").trim();
    if (!no) continue;
    if (normalizeKey(no) === "번호") continue;
    const name = nameIdx >= 0 ? (r[nameIdx] || "").trim() : "";
    const price = parsePrice(r[priceIdx]);
    next.set(normalizeKey(no), { no, name, price });
  }
  if (next.size === 0) {
    showToast("유효한 데이터 행이 없습니다.", "error");
    return;
  }
  catalog = next;
  await saveCatalog();
  renderCatalog();
  updateDataStatus();
  renderCollection();
  showToast(`${next.size.toLocaleString("ko-KR")}건의 가격 데이터를 등록했습니다.`, "success");
}

// ---------- Firestore I/O ----------
function catalogDocRef() {
  if (!userId) return null;
  return doc(db, "users", userId, "data", "catalog");
}
function collectionDocRef() {
  if (!userId) return null;
  return doc(db, "users", userId, "data", "collection");
}

function mapToObject(map) {
  const out = {};
  for (const [k, v] of map) out[k] = v;
  return out;
}

async function saveCatalog() {
  const ref = catalogDocRef();
  if (!ref) return;
  beginSaving();
  try {
    await setDoc(ref, {
      items: mapToObject(catalog),
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    console.error("saveCatalog failed", e);
    showToast("가격 데이터 저장 실패: " + (e.message || e), "error");
  } finally {
    endSaving();
  }
}

async function saveCollection() {
  const ref = collectionDocRef();
  if (!ref) return;
  beginSaving();
  try {
    await setDoc(ref, {
      items: mapToObject(collection),
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    console.error("saveCollection failed", e);
    showToast("보유 목록 저장 실패: " + (e.message || e), "error");
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
      if (pendingSaves === 0) {
        setSyncStatus(navigator.onLine ? "synced" : "offline");
      }
    }, 250);
  }
}

function attachListeners(uid) {
  if (catalogUnsub) catalogUnsub();
  if (collectionUnsub) collectionUnsub();

  catalogUnsub = onSnapshot(
    catalogDocRef(),
    (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const items = (data && data.items) || {};
      catalog = new Map(Object.entries(items));
      updateDataStatus();
      renderCatalog();
      renderCollection();
      if (!initialCatalogLoaded) {
        initialCatalogLoaded = true;
        maybeMigrateLegacyData();
      }
    },
    (err) => {
      console.error("catalog snapshot error", err);
      setSyncStatus("error", "권한 오류");
      showToast("가격 데이터 동기화 실패: " + (err.message || err), "error");
    },
  );

  collectionUnsub = onSnapshot(
    collectionDocRef(),
    (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const items = (data && data.items) || {};
      collection = new Map(Object.entries(items));
      renderCollection();
      if (!initialCollectionLoaded) {
        initialCollectionLoaded = true;
        maybeMigrateLegacyData();
      }
      if (!snap.metadata.hasPendingWrites && pendingSaves === 0) {
        setSyncStatus(navigator.onLine ? "synced" : "offline");
      }
    },
    (err) => {
      console.error("collection snapshot error", err);
      setSyncStatus("error", "권한 오류");
      showToast("보유 목록 동기화 실패: " + (err.message || err), "error");
    },
  );
}

async function maybeMigrateLegacyData() {
  if (migrationAttempted) return;
  if (!initialCatalogLoaded || !initialCollectionLoaded) return;
  migrationAttempted = true;

  const oldCatalog = localStorage.getItem(LEGACY_KEYS.catalog);
  const oldCollection = localStorage.getItem(LEGACY_KEYS.collection);
  if (!oldCatalog && !oldCollection) return;

  let migrated = false;
  try {
    if (oldCatalog && catalog.size === 0) {
      const obj = JSON.parse(oldCatalog);
      if (obj && typeof obj === "object") {
        catalog = new Map(Object.entries(obj));
        await saveCatalog();
        migrated = true;
      }
    }
    if (oldCollection && collection.size === 0) {
      const obj = JSON.parse(oldCollection);
      if (obj && typeof obj === "object") {
        collection = new Map(Object.entries(obj));
        await saveCollection();
        migrated = true;
      }
    }
  } catch (e) {
    console.warn("legacy migration failed", e);
    return;
  }

  if (migrated) {
    localStorage.removeItem(LEGACY_KEYS.catalog);
    localStorage.removeItem(LEGACY_KEYS.collection);
    showToast("이전 브라우저 저장 데이터를 가져왔습니다.", "success");
  }
}

// ---------- UI helpers ----------
function updateDataStatus() {
  els.dataStatus.textContent =
    catalog.size > 0 ? `${catalog.size.toLocaleString("ko-KR")}건 로드됨` : "데이터 없음";
  els.catalogCount.textContent = `${catalog.size.toLocaleString("ko-KR")}건`;
}

function renderCatalog() {
  const q = normalizeKey(els.catalogSearch.value);
  const items = [];
  for (const [key, v] of catalog) {
    if (!q || key.includes(q) || normalizeKey(v.name).includes(q)) items.push(v);
  }
  items.sort((a, b) => a.no.localeCompare(b.no, "ko"));
  const limit = 200;
  const shown = items.slice(0, limit);
  const tbody = els.catalogBody;
  tbody.innerHTML = "";
  for (const item of shown) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHTML(item.no)}</td>
      <td>${escapeHTML(item.name || "")}</td>
      <td class="num">${formatPrice(item.price)}</td>
      <td class="num"><button class="icon-btn" data-add="${escapeAttr(item.no)}" title="목록에 추가">＋ 추가</button></td>
    `;
    tbody.appendChild(tr);
  }
  if (items.length > limit) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" class="empty">${items.length - limit}건이 더 있습니다. 검색으로 좁혀보세요.</td>`;
    tbody.appendChild(tr);
  }
  if (items.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" class="empty">${catalog.size === 0 ? "가격 데이터를 먼저 등록하세요." : "검색 결과가 없습니다."}</td>`;
    tbody.appendChild(tr);
  }
}

function renderCollection() {
  const tbody = els.collectionBody;
  tbody.innerHTML = "";
  const q = normalizeKey(els.collectionSearch.value);

  let totalQty = 0;
  let totalSum = 0;
  let visibleCount = 0;

  const rows = [];
  for (const [key, entry] of collection) {
    const meta = catalog.get(key);
    rows.push({
      key,
      no: meta ? meta.no : entry.no || key,
      name: meta ? meta.name : entry.name || "",
      price: meta ? meta.price : entry.price || 0,
      qty: entry.qty || 0,
      missing: !meta,
    });
  }
  rows.sort((a, b) => a.no.localeCompare(b.no, "ko"));

  for (const r of rows) {
    totalQty += r.qty;
    totalSum += r.qty * r.price;
    const matches = !q || normalizeKey(r.no).includes(q) || normalizeKey(r.name).includes(q);
    if (!matches) continue;
    visibleCount++;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHTML(r.no)}${r.missing ? ' <span class="missing-tag">데이터 없음</span>' : ""}</td>
      <td>${escapeHTML(r.name)}</td>
      <td class="num">${formatPrice(r.price)}</td>
      <td class="num">
        <input type="number" class="qty-input" min="0" step="1" value="${r.qty}" data-key="${escapeAttr(r.key)}" aria-label="수량" />
      </td>
      <td class="num">${formatPrice(r.qty * r.price)}</td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" data-inc="${escapeAttr(r.key)}" title="1장 추가">＋</button>
          <button class="icon-btn" data-dec="${escapeAttr(r.key)}" title="1장 빼기">－</button>
          <button class="icon-btn danger" data-remove="${escapeAttr(r.key)}" title="삭제">×</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }

  if (rows.length === 0) {
    els.collectionEmpty.textContent = "아직 추가된 카드가 없습니다.";
    els.collectionEmpty.classList.remove("hidden");
  } else if (visibleCount === 0) {
    els.collectionEmpty.textContent = "검색 결과가 없습니다.";
    els.collectionEmpty.classList.remove("hidden");
  } else {
    els.collectionEmpty.classList.add("hidden");
  }

  els.totalsCount.textContent = `${rows.length}종 / ${totalQty.toLocaleString("ko-KR")}장`;
  els.totalsSum.textContent = formatPrice(totalSum);
}

// ---------- Mutations ----------
async function addCardByNo(rawNo, qty = 1) {
  const key = normalizeKey(rawNo);
  if (!key) return { ok: false, msg: "일련번호를 입력하세요." };
  const meta = catalog.get(key);
  const entry = collection.get(key) || { qty: 0 };
  entry.qty = (entry.qty || 0) + qty;
  if (meta) {
    entry.no = meta.no;
    entry.name = meta.name;
    entry.price = meta.price;
  } else {
    entry.no = entry.no || rawNo.trim();
    entry.name = entry.name || "";
    entry.price = entry.price || 0;
  }
  if (entry.qty <= 0) collection.delete(key);
  else collection.set(key, entry);
  renderCollection();
  await saveCollection();
  return {
    ok: true,
    meta,
    msg: meta
      ? `추가됨: ${meta.no} ${meta.name} (${formatPrice(meta.price)})`
      : `추가됨: ${rawNo.trim()} (가격 데이터 없음)`,
  };
}

async function setQty(key, qty) {
  const k = normalizeKey(key);
  qty = Math.max(0, Math.floor(Number(qty) || 0));
  const entry = collection.get(k);
  if (!entry) return;
  if (qty === 0) collection.delete(k);
  else { entry.qty = qty; collection.set(k, entry); }
  renderCollection();
  await saveCollection();
}

async function removeCard(key) {
  collection.delete(normalizeKey(key));
  renderCollection();
  await saveCollection();
}

// ---------- Suggestions ----------
let suggestionIndex = -1;
function showSuggestions(query) {
  const q = normalizeKey(query);
  const list = els.suggestions;
  list.innerHTML = "";
  suggestionIndex = -1;
  if (!q || catalog.size === 0) {
    list.classList.add("hidden");
    return;
  }
  const matches = [];
  for (const [key, v] of catalog) {
    if (key.includes(q) || normalizeKey(v.name).includes(q)) {
      matches.push(v);
      if (matches.length >= 10) break;
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
      <span class="price">${formatPrice(m.price)}</span>
    `;
    list.appendChild(li);
  }
  list.classList.remove("hidden");
}

function moveSuggestion(delta) {
  const items = Array.from(els.suggestions.querySelectorAll("li"));
  if (items.length === 0) return;
  suggestionIndex = (suggestionIndex + delta + items.length) % items.length;
  items.forEach((it, i) => it.classList.toggle("active", i === suggestionIndex));
  items[suggestionIndex].scrollIntoView({ block: "nearest" });
}

function previewCard(query) {
  const q = normalizeKey(query);
  if (!q) {
    els.cardPreview.textContent = "";
    els.cardPreview.classList.remove("found", "error");
    return;
  }
  const meta = catalog.get(q);
  if (meta) {
    els.cardPreview.textContent = `${meta.no} · ${meta.name} · ${formatPrice(meta.price)}`;
    els.cardPreview.classList.add("found");
    els.cardPreview.classList.remove("error");
  } else {
    els.cardPreview.textContent =
      catalog.size === 0
        ? "가격 데이터를 먼저 등록하세요."
        : "일치하는 카드가 없습니다 (가격 0원으로 추가됩니다).";
    els.cardPreview.classList.remove("found");
    els.cardPreview.classList.add("error");
  }
}

// ---------- Export ----------
function exportCollectionCSV() {
  if (collection.size === 0) {
    showToast("내보낼 카드가 없습니다.", "error");
    return;
  }
  const rows = [["번호", "카드 이름", "단가", "수량", "합계"]];
  let total = 0;
  const items = [];
  for (const [key, entry] of collection) {
    const meta = catalog.get(key);
    items.push({
      no: meta ? meta.no : entry.no || key,
      name: meta ? meta.name : entry.name || "",
      price: meta ? meta.price : entry.price || 0,
      qty: entry.qty || 0,
    });
  }
  items.sort((a, b) => a.no.localeCompare(b.no, "ko"));
  for (const r of items) {
    const sum = r.price * r.qty;
    total += sum;
    rows.push([r.no, r.name, r.price, r.qty, sum]);
  }
  rows.push(["", "합계", "", "", total]);
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pokemon-collection-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- Sample ----------
const SAMPLE_DATA =
`순번\t번호\t카드 이름\t가격(원)
1\tsv10 001\t피콘\t300
2\tsv10 002\t버섯꼬\t300
3\tsv10 003\t버섯모\t300
4\tsv10 004\t커트로토무\t300
5\tsv10 005\t짜랑랑\t300
6\tsv10 006\t라란티스\t500
7\tsv10 007\t로켓단의 두루지벌레\t300
8\tsv10 008\t로켓단의 타랜툴라\t800
9\tsv10 009\t로켓단의 트래피더\t3500
10\tsv10 010\t미니브\t300
11\tsv10 011\t올리뇨\t300
12\tsv10 012\t올리르바ex\t2000
13\tsv10 013\t가디\t300
14\tsv10 014\t윈디\t300
15\tsv10 015\t로켓단의 파이어ex\t2500
16\tsv10 016\t로켓단의 델빌\t300
17\tsv10 017\t로켓단의 헬가\t300
18\tsv10 018\t아차모\t600
19\tsv10 019\t영치코\t800
20\tsv10 020\t번치코\t2000
21\tsv10 021\t히트로토무\t300
22\tsv10 022\t로켓단의 프리져\t3000
23\tsv10 023\t진주몽\t300
24\tsv10 024\t헌테일\t500
25\tsv10 025\t분홍장이\t800
26\tsv10 026\t눈쓰개\t300`;

// ---------- Wiring ----------
els.csvFile.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importCatalogFromText(String(reader.result || ""));
    els.csvFile.value = "";
  };
  reader.readAsText(file, "utf-8");
});

els.pasteToggle.addEventListener("click", () => {
  els.pasteArea.classList.toggle("hidden");
  if (!els.pasteArea.classList.contains("hidden")) els.pasteInput.focus();
});
els.pasteApply.addEventListener("click", () => {
  importCatalogFromText(els.pasteInput.value);
});
els.sampleLoad.addEventListener("click", () => {
  els.pasteArea.classList.remove("hidden");
  els.pasteInput.value = SAMPLE_DATA;
  els.pasteInput.focus();
});
els.dataClear.addEventListener("click", async () => {
  if (catalog.size === 0) return;
  if (!confirm("가격 데이터를 모두 삭제할까요? (보유 목록은 유지됩니다)")) return;
  catalog = new Map();
  updateDataStatus();
  renderCatalog();
  renderCollection();
  await saveCatalog();
});

els.addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const no = els.cardInput.value.trim();
  const qty = Math.max(1, parseInt(els.qtyInput.value, 10) || 1);
  if (!no) return;
  const result = await addCardByNo(no, qty);
  if (result.ok) {
    els.cardPreview.textContent = result.msg;
    els.cardPreview.classList.remove("error");
    els.cardPreview.classList.add("found");
    els.cardInput.value = "";
    els.qtyInput.value = "1";
    els.suggestions.classList.add("hidden");
    els.cardInput.focus();
  } else {
    els.cardPreview.textContent = result.msg;
    els.cardPreview.classList.add("error");
  }
});

els.cardInput.addEventListener("input", (e) => {
  const v = e.target.value;
  showSuggestions(v);
  previewCard(v);
});
els.cardInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); moveSuggestion(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveSuggestion(-1); }
  else if (e.key === "Enter" && suggestionIndex >= 0) {
    e.preventDefault();
    const items = Array.from(els.suggestions.querySelectorAll("li"));
    if (items[suggestionIndex]) {
      els.cardInput.value = items[suggestionIndex].dataset.no;
      els.suggestions.classList.add("hidden");
      previewCard(els.cardInput.value);
    }
  } else if (e.key === "Escape") {
    els.suggestions.classList.add("hidden");
  }
});
els.cardInput.addEventListener("blur", () => {
  setTimeout(() => els.suggestions.classList.add("hidden"), 150);
});
els.cardInput.addEventListener("focus", (e) => {
  if (e.target.value) showSuggestions(e.target.value);
});

els.suggestions.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  e.preventDefault();
  els.cardInput.value = li.dataset.no;
  els.suggestions.classList.add("hidden");
  previewCard(li.dataset.no);
  els.qtyInput.focus();
});

els.collectionBody.addEventListener("click", async (e) => {
  const inc = e.target.closest("[data-inc]");
  const dec = e.target.closest("[data-dec]");
  const rm = e.target.closest("[data-remove]");
  if (inc) await addCardByNo(inc.dataset.inc, 1);
  else if (dec) await addCardByNo(dec.dataset.dec, -1);
  else if (rm) await removeCard(rm.dataset.remove);
});
els.collectionBody.addEventListener("change", async (e) => {
  const input = e.target.closest(".qty-input");
  if (!input) return;
  await setQty(input.dataset.key, input.value);
});

els.catalogBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-add]");
  if (!btn) return;
  await addCardByNo(btn.dataset.add, 1);
  showToast(`추가됨: ${btn.dataset.add}`, "success");
});

els.collectionSearch.addEventListener("input", renderCollection);
els.catalogSearch.addEventListener("input", renderCatalog);
els.exportBtn.addEventListener("click", exportCollectionCSV);
els.collectionClear.addEventListener("click", async () => {
  if (collection.size === 0) return;
  if (!confirm("보유 카드 목록을 모두 비울까요?")) return;
  collection = new Map();
  renderCollection();
  await saveCollection();
});

window.addEventListener("online", () => {
  if (pendingSaves === 0) setSyncStatus("synced");
});
window.addEventListener("offline", () => setSyncStatus("offline"));

// ---------- Auth bootstrap ----------
setSyncStatus("connecting");
onAuthStateChanged(auth, (user) => {
  if (user) {
    userId = user.uid;
    setSyncStatus(navigator.onLine ? "synced" : "offline");
    attachListeners(user.uid);
  } else {
    setSyncStatus("connecting", "로그인 중…");
    signInAnonymously(auth).catch((err) => {
      console.error("anonymous sign-in failed", err);
      setSyncStatus("error", "로그인 실패");
      showToast(
        "Firebase 인증에 실패했습니다. 콘솔에서 익명 로그인을 활성화했는지 확인하세요.",
        "error",
      );
    });
  }
});

// Initial render of empty state
updateDataStatus();
renderCatalog();
renderCollection();
