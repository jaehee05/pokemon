#!/usr/bin/env node
// 포켓몬코리아 카드 카탈로그 크롤러 (수동 실행용)
//
// 사용법:
//   node scripts/scrape-pokemon-korea.mjs > catalog.csv
//   node scripts/scrape-pokemon-korea.mjs sv10 > sv10.csv
//
// 이 스크립트는 https://pokemonkorea.co.kr/cardgame 의 카드 목록 페이지를
// 페이지네이션하며 긁어와서 CSV(일련번호,카드명,등급,가치) 형식으로 출력합니다.
// 사이트 구조가 바뀌면 SELECTORS 부분만 수정하면 됩니다.
//
// 결과 CSV는 사이트의 "CSV 가져오기" 버튼으로 그대로 임포트할 수 있습니다.
//
// ⚠️ 주의:
//  - 본 스크립트는 개인 사용 목적입니다. 과도한 요청은 서버에 부담을 주므로
//    DELAY_MS 상수를 통해 요청 간격을 두세요.
//  - 사이트 약관(robots.txt 등)을 확인하고 사용하세요.

import { setTimeout as sleep } from "node:timers/promises";

const BASE = "https://pokemonkorea.co.kr";
const LIST_URL = `${BASE}/cardgame/cardlist`; // 실제 URL은 사이트에서 확인
const DELAY_MS = 800;

// 사이트 구조에 맞게 수정하세요. (DOM이 JS-렌더링이라면 fetch로는 부족하고
// playwright/puppeteer 같은 헤드리스 브라우저가 필요할 수 있습니다.)
const SELECTORS = {
  cardItem: ".card-item",          // 카드 카드 컨테이너
  serial:   ".card-no",            // 일련번호 (예: sv10-032)
  name:     ".card-title",         // 카드 이름
  grade:    ".card-rarity",        // 등급 (RR, R, U, AR ...)
};

// ── 파라미터 파싱 ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const setFilter = args[0] || ""; // 비어있으면 전체

// ── 메인 ────────────────────────────────────────────────────────────
async function main() {
  const out = [];
  let page = 1;
  while (true) {
    const url = `${LIST_URL}?page=${page}${setFilter ? `&set=${encodeURIComponent(setFilter)}` : ""}`;
    process.stderr.write(`Fetching page ${page}: ${url}\n`);
    const html = await fetchHtml(url);
    if (!html) break;
    const cards = parseCards(html);
    if (cards.length === 0) break;
    out.push(...cards);
    page += 1;
    await sleep(DELAY_MS);
  }
  // CSV 출력 (header + rows)
  const header = ["일련번호", "카드명", "등급", "가치"];
  console.log(toCSVRow(header));
  for (const c of out) {
    console.log(toCSVRow([c.no, c.name, c.grade, c.value || ""]));
  }
  process.stderr.write(`Done. ${out.length} cards.\n`);
}

async function fetchHtml(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; pokemon-inventory/1.0)",
        "Accept-Language": "ko",
      },
    });
    if (!res.ok) {
      process.stderr.write(`HTTP ${res.status} on ${url}\n`);
      return null;
    }
    return await res.text();
  } catch (e) {
    process.stderr.write(`Fetch error: ${e.message}\n`);
    return null;
  }
}

// 매우 단순한 HTML 파서 (필요시 cheerio 등을 import 해서 교체)
function parseCards(html) {
  const cards = [];
  // 정규식 기반 추출 — 사이트 구조에 맞게 수정 필요.
  // 예시: <div class="card-item"> ... </div>
  const itemRe = /<div[^>]*class="[^"]*card-item[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1];
    const no = extract(block, /class="[^"]*card-no[^"]*"[^>]*>([^<]+)/);
    const name = extract(block, /class="[^"]*card-title[^"]*"[^>]*>([^<]+)/);
    const grade = extract(block, /class="[^"]*card-rarity[^"]*"[^>]*>([^<]+)/);
    if (no && name) {
      cards.push({
        no: no.trim().toLowerCase(),
        name: name.trim(),
        grade: (grade || "").trim().toUpperCase(),
        value: "",
      });
    }
  }
  return cards;
}

function extract(text, re) {
  const m = text.match(re);
  return m ? m[1] : "";
}

function toCSVRow(arr) {
  return arr.map((v) => {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
