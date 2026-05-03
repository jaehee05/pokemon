(() => {
  "use strict";

  const STORAGE_KEYS = {
    catalog: "pokemon_catalog_v1",
    collection: "pokemon_collection_v1",
  };

  let catalog = new Map();
  let collection = new Map();

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
  };

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

  function detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] || "";
    const tabs = (firstLine.match(/\t/g) || []).length;
    const commas = (firstLine.match(/,/g) || []).length;
    if (tabs >= commas) return "\t";
    return ",";
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
        } else {
          field += c;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
        } else if (c === delimiter) {
          row.push(field); field = "";
        } else if (c === "\n") {
          row.push(field); field = "";
          rows.push(row); row = [];
        } else if (c === "\r") {
          // skip
        } else {
          field += c;
        }
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
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

  function importCatalogFromText(text) {
    const trimmed = text.trim();
    if (!trimmed) {
      alert("붙여넣을 내용이 없습니다.");
      return;
    }
    const delim = detectDelimiter(trimmed);
    const rows = parseCSV(trimmed, delim);
    if (rows.length === 0) {
      alert("데이터를 인식할 수 없습니다.");
      return;
    }

    let header = rows[0].map((h) => normalizeKey(h));
    let dataRows = rows.slice(1);

    const looksLikeHeader =
      header.some((h) => /번호|이름|가격|순번|name|price|no\.?$|number/i.test(h));
    if (!looksLikeHeader) {
      header = ["순번", "번호", "카드 이름", "가격"];
      dataRows = rows;
    }

    const noIdx = findColumnIndex(header, ["번호", "no", "number", "code"]);
    const nameIdx = findColumnIndex(header, ["이름", "name", "카드"]);
    const priceIdx = findColumnIndex(header, ["가격", "price", "원"]);

    if (noIdx === -1 || priceIdx === -1) {
      alert("번호/가격 열을 찾을 수 없습니다. 헤더를 확인해주세요.\n예: 순번, 번호, 카드 이름, 가격(원)");
      return;
    }

    const next = new Map();
    let added = 0;
    for (const r of dataRows) {
      const no = (r[noIdx] || "").trim();
      if (!no) continue;
      // skip a duplicated header row
      if (normalizeKey(no) === "번호") continue;
      const name = nameIdx >= 0 ? (r[nameIdx] || "").trim() : "";
      const price = parsePrice(r[priceIdx]);
      const key = normalizeKey(no);
      next.set(key, { no, name, price });
      added++;
    }
    if (added === 0) {
      alert("유효한 데이터 행이 없습니다.");
      return;
    }
    catalog = next;
    saveCatalog();
    renderCatalog();
    updateDataStatus();
    renderCollection();
  }

  function saveCatalog() {
    const obj = {};
    for (const [k, v] of catalog) obj[k] = v;
    localStorage.setItem(STORAGE_KEYS.catalog, JSON.stringify(obj));
  }

  function loadCatalog() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.catalog);
      if (!raw) return;
      const obj = JSON.parse(raw);
      catalog = new Map(Object.entries(obj));
    } catch (e) {
      console.warn("catalog load failed", e);
    }
  }

  function saveCollection() {
    const obj = {};
    for (const [k, v] of collection) obj[k] = v;
    localStorage.setItem(STORAGE_KEYS.collection, JSON.stringify(obj));
  }

  function loadCollection() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.collection);
      if (!raw) return;
      const obj = JSON.parse(raw);
      collection = new Map(Object.entries(obj));
    } catch (e) {
      console.warn("collection load failed", e);
    }
  }

  function updateDataStatus() {
    els.dataStatus.textContent = catalog.size > 0
      ? `${catalog.size.toLocaleString()}건 로드됨`
      : "데이터 없음";
    els.catalogCount.textContent = `${catalog.size.toLocaleString("ko-KR")}건`;
  }

  function renderCatalog() {
    const q = normalizeKey(els.catalogSearch.value);
    const items = [];
    for (const [key, v] of catalog) {
      if (!q || key.includes(q) || normalizeKey(v.name).includes(q)) {
        items.push(v);
      }
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
        <td class="num"><button class="icon-btn" data-add="${escapeAttr(item.no)}">＋ 추가</button></td>
      `;
      tbody.appendChild(tr);
    }
    if (items.length > limit) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="4" class="empty">${items.length - limit}건이 더 있습니다. 검색으로 좁혀보세요.</td>`;
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
      const name = meta ? meta.name : (entry.name || "");
      const price = meta ? meta.price : (entry.price || 0);
      const no = meta ? meta.no : (entry.no || key);
      rows.push({ key, no, name, price, qty: entry.qty });
    }
    rows.sort((a, b) => a.no.localeCompare(b.no, "ko"));

    for (const r of rows) {
      totalQty += r.qty;
      totalSum += r.qty * r.price;
      const matches = !q || normalizeKey(r.no).includes(q) || normalizeKey(r.name).includes(q);
      if (!matches) continue;
      visibleCount++;
      const tr = document.createElement("tr");
      const missing = !catalog.has(r.key);
      tr.innerHTML = `
        <td>${escapeHTML(r.no)}${missing ? ' <span class="hint">(가격 데이터 없음)</span>' : ""}</td>
        <td>${escapeHTML(r.name)}</td>
        <td class="num">${formatPrice(r.price)}</td>
        <td class="num">
          <input type="number" class="qty-input" min="0" step="1" value="${r.qty}" data-key="${escapeAttr(r.key)}" />
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

    els.collectionEmpty.classList.toggle("hidden", rows.length > 0);
    if (rows.length > 0 && visibleCount === 0) {
      els.collectionEmpty.textContent = "검색 결과가 없습니다.";
      els.collectionEmpty.classList.remove("hidden");
    } else {
      els.collectionEmpty.textContent = "아직 추가된 카드가 없습니다.";
    }

    els.totalsCount.textContent = `${rows.length}종 / ${totalQty.toLocaleString("ko-KR")}장`;
    els.totalsSum.textContent = formatPrice(totalSum);
  }

  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function escapeAttr(s) {
    return escapeHTML(s);
  }

  function addCardByNo(rawNo, qty = 1) {
    const key = normalizeKey(rawNo);
    if (!key) return { ok: false, msg: "일련번호를 입력하세요." };
    const meta = catalog.get(key);
    const entry = collection.get(key) || { qty: 0 };
    entry.qty += qty;
    if (meta) {
      entry.no = meta.no;
      entry.name = meta.name;
      entry.price = meta.price;
    } else {
      entry.no = rawNo.trim();
      entry.name = entry.name || "";
      entry.price = entry.price || 0;
    }
    if (entry.qty <= 0) {
      collection.delete(key);
    } else {
      collection.set(key, entry);
    }
    saveCollection();
    renderCollection();
    return {
      ok: true,
      meta,
      msg: meta
        ? `추가됨: ${meta.no} ${meta.name} (${formatPrice(meta.price)})`
        : `추가됨: ${rawNo.trim()} (가격 데이터 없음)`,
    };
  }

  function setQty(key, qty) {
    const k = normalizeKey(key);
    qty = Math.max(0, Math.floor(Number(qty) || 0));
    const entry = collection.get(k);
    if (!entry) return;
    if (qty === 0) collection.delete(k);
    else { entry.qty = qty; collection.set(k, entry); }
    saveCollection();
    renderCollection();
  }

  function removeCard(key) {
    collection.delete(normalizeKey(key));
    saveCollection();
    renderCollection();
  }

  function showSuggestions(query) {
    const q = normalizeKey(query);
    const list = els.suggestions;
    list.innerHTML = "";
    if (!q || catalog.size === 0) {
      list.classList.add("hidden");
      return;
    }
    const matches = [];
    for (const [key, v] of catalog) {
      if (key.includes(q) || normalizeKey(v.name).includes(q)) {
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
        <span>${formatPrice(m.price)}</span>
      `;
      list.appendChild(li);
    }
    list.classList.remove("hidden");
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
      els.cardPreview.textContent = catalog.size === 0
        ? "가격 데이터를 먼저 등록하세요."
        : "일치하는 카드가 없습니다 (가격 0원으로 추가됩니다).";
      els.cardPreview.classList.remove("found");
      els.cardPreview.classList.add("error");
    }
  }

  function exportCollectionCSV() {
    if (collection.size === 0) {
      alert("내보낼 카드가 없습니다.");
      return;
    }
    const rows = [["번호", "카드 이름", "단가", "수량", "합계"]];
    let total = 0;
    const items = [];
    for (const [key, entry] of collection) {
      const meta = catalog.get(key);
      const name = meta ? meta.name : (entry.name || "");
      const price = meta ? meta.price : (entry.price || 0);
      const no = meta ? meta.no : (entry.no || key);
      items.push({ no, name, price, qty: entry.qty });
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
    a.download = "pokemon-collection.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  function csvEscape(v) {
    const s = String(v == null ? "" : v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

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

  // Event wiring
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
    if (!els.pasteArea.classList.contains("hidden")) {
      els.pasteInput.focus();
    }
  });
  els.pasteApply.addEventListener("click", () => {
    importCatalogFromText(els.pasteInput.value);
  });

  els.sampleLoad.addEventListener("click", () => {
    els.pasteArea.classList.remove("hidden");
    els.pasteInput.value = SAMPLE_DATA;
    els.pasteInput.focus();
  });

  els.dataClear.addEventListener("click", () => {
    if (catalog.size === 0) return;
    if (!confirm("가격 데이터를 모두 삭제할까요? (보유 목록은 유지됩니다)")) return;
    catalog = new Map();
    saveCatalog();
    updateDataStatus();
    renderCatalog();
    renderCollection();
  });

  els.addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const no = els.cardInput.value.trim();
    const qty = Math.max(1, parseInt(els.qtyInput.value, 10) || 1);
    if (!no) return;
    const result = addCardByNo(no, qty);
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
  els.cardInput.addEventListener("blur", () => {
    setTimeout(() => els.suggestions.classList.add("hidden"), 150);
  });
  els.cardInput.addEventListener("focus", (e) => {
    if (e.target.value) showSuggestions(e.target.value);
  });

  els.suggestions.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    els.cardInput.value = li.dataset.no;
    els.suggestions.classList.add("hidden");
    previewCard(li.dataset.no);
    els.qtyInput.focus();
  });

  els.collectionBody.addEventListener("click", (e) => {
    const inc = e.target.closest("[data-inc]");
    const dec = e.target.closest("[data-dec]");
    const rm = e.target.closest("[data-remove]");
    if (inc) addCardByNo(inc.dataset.inc, 1);
    else if (dec) addCardByNo(dec.dataset.dec, -1);
    else if (rm) removeCard(rm.dataset.remove);
  });
  els.collectionBody.addEventListener("change", (e) => {
    const input = e.target.closest(".qty-input");
    if (!input) return;
    setQty(input.dataset.key, input.value);
  });

  els.catalogBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-add]");
    if (!btn) return;
    addCardByNo(btn.dataset.add, 1);
  });

  els.collectionSearch.addEventListener("input", renderCollection);
  els.catalogSearch.addEventListener("input", renderCatalog);
  els.exportBtn.addEventListener("click", exportCollectionCSV);
  els.collectionClear.addEventListener("click", () => {
    if (collection.size === 0) return;
    if (!confirm("보유 카드 목록을 모두 비울까요?")) return;
    collection = new Map();
    saveCollection();
    renderCollection();
  });

  // Init
  loadCatalog();
  loadCollection();
  updateDataStatus();
  renderCatalog();
  renderCollection();
})();
