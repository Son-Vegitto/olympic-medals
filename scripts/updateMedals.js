// scripts/updateMedals.js
import fs from "node:fs";
import path from "node:path";
import { load } from "cheerio";

// ---- Config ----
const GAME_PAGE = process.env.GAME_PAGE || "2026_Winter_Olympics_medal_table";
const GAMES_NAME = process.env.GAMES_NAME || "Milano Cortina 2026";
const PLACEHOLDER_COUNT = parseInt(process.env.PLACEHOLDER_COUNT || "10", 10);
const TOP_N = parseInt(process.env.TOP_N || "5", 10);

const OUT_FILE = path.join("public", "medals.json");

// ---- Helpers ----
function num(x) {
  const n = parseInt(String(x).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function flagPngFromIso2(iso2) {
  if (!iso2) return null;
  return `https://raw.githubusercontent.com/Son-Vegitto/olympic-medals/main/flags/${String(iso2).toLowerCase()}.png`;
}

// ---- Minimal maps (extend as needed) ----
const NOC_TO_ISO2 = {
  ITA: "it",
  SUI: "ch",
  FRA: "fr",
  GER: "de",
  USA: "us",
  CAN: "ca",
  AUT: "at",
  NED: "nl",
  NOR: "no",
  SWE: "se",
  FIN: "fi",
  CZE: "cz",
  SVK: "sk",
  SLO: "si",
  POL: "pl",
  HUN: "hu",
  LAT: "lv",
  LTU: "lt",
  EST: "ee",
  GBR: "gb",
  JPN: "jp",
  KOR: "kr",
  CHN: "cn"
};

const NAME_TO_NOC = {
  Italy: "ITA",
  Switzerland: "SUI",
  France: "FRA",
  Germany: "GER",
  "United States": "USA",
  Canada: "CAN",
  Austria: "AUT",
  Netherlands: "NED",
  Norway: "NOR",
  Sweden: "SWE",
  Finland: "FIN",
  Czechia: "CZE",
  "Czech Republic": "CZE",
  Slovakia: "SVK",
  Slovenia: "SLO",
  Poland: "POL",
  Hungary: "HUN",
  Latvia: "LAT",
  Lithuania: "LTU",
  Estonia: "EST",
  "Great Britain": "GBR",
  "United Kingdom": "GBR",
  Japan: "JPN",
  "South Korea": "KOR",
  Korea: "KOR",
  China: "CHN"
};

function inferNoc(countryName, rawCellText) {
  const t = String(rawCellText || "").replace(/\s+/g, " ").trim();
  const m = t.match(/\(([A-Z]{3})\)\s*$/);
  if (m) return m[1];
  const last = t.split(" ").pop();
  if (/^[A-Z]{3}$/.test(last)) return last;
  return NAME_TO_NOC[countryName] || null;
}

function inferFlag(noc) {
  const iso2 = NOC_TO_ISO2[noc];
  return flagPngFromIso2(iso2);
}

function buildPlaceholders(count) {
  const defaults = [
    { name: "Italy", noc: "ITA" },
    { name: "Switzerland", noc: "SUI" },
    { name: "Norway", noc: "NOR" },
    { name: "Germany", noc: "GER" },
    { name: "Canada", noc: "CAN" }
  ];

  return Array.from({ length: count }, (_, i) => {
    const base = defaults[i % defaults.length];
    return {
      rank: i + 1,
      noc: base.noc,
      name: base.name,
      gold: 0,
      silver: 0,
      bronze: 0,
      total: 0,
      flag: inferFlag(base.noc),
      placeholder: true
    };
  });
}

// ---- Wikipedia (MediaWiki API parse) ----
async function fetchParsedHtml(pageTitle) {
  const apiUrl =
    "https://en.wikipedia.org/w/api.php" +
    `?action=parse&format=json&prop=text&formatversion=2&redirects=1&origin=*` +
    `&page=${encodeURIComponent(pageTitle)}`;

  const res = await fetch(apiUrl, {
    headers: { "User-Agent": "olympics-medals-widget/1.0 (GitHub Actions)" }
  });
  if (!res.ok) throw new Error(`Failed to fetch MediaWiki API: ${res.status} ${res.statusText}`);

  const data = await res.json();
  const html = data?.parse?.text;
  if (!html) throw new Error("MediaWiki API parse response missing HTML content");

  return {
    sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`,
    html
  };
}

/**
 * TRUE tied-rank version:
 * - Uses original medal-column logic
 * - Adds true tied-rank behavior (1, 2, 2, 4, 5…)
 * - Still takes FIRST TOP_N rows in display order
 */
function parseTopRowsInDisplayOrder(html, topN) {
  const $ = load(html);

  // Find the medal table by header
  let medalTable = null;
  $("table.wikitable").each((_, t) => {
    const header = $(t).find("tr").first().text().toLowerCase();
    if (
      header.includes("gold") &&
      header.includes("silver") &&
      header.includes("bronze") &&
      header.includes("total")
    ) {
      medalTable = t;
      return false;
    }
  });

  if (!medalTable) return [];

  const rows = [];

  $(medalTable)
    .find("tr")
    .slice(1)
    .each((_, tr) => {
      if (rows.length >= topN) return;

      const cells = $(tr).children("th, td");
      if (cells.length < 5) return;

      // Detect whether first cell is a rank
      const firstText = $(cells[0]).text().replace(/\s+/g, " ").trim();
      const firstIsRank = /^[0-9]+$/.test(firstText);

      const start = firstIsRank ? 1 : 0;

      // Country cell
      const countryCell = $(cells[start]);
      if (!countryCell || countryCell.length === 0) return;

      // Extract country name
      let name =
        countryCell
          .find('a[href^="/wiki/"]')
          .first()
          .text()
          .replace(/\s+/g, " ")
          .trim() ||
        countryCell.text().replace(/\s+/g, " ").trim();

      name = name.replace(/\*+$/g, "").trim();
      if (!name) return;
      if (name.toLowerCase().startsWith("totals")) return;

      // Medal columns (original logic)
      const gold = num($(cells[start + 1]).text());
      const silver = num($(cells[start + 2]).text());
      const bronze = num($(cells[start + 3]).text());
      const total = num($(cells[start + 4]).text());

      const noc = inferNoc(name, countryCell.text());
      const flag = noc ? inferFlag(noc) : null;

      rows.push({
        rank: null, // will be assigned below
        noc: noc || name,
        name,
        gold,
        silver,
        bronze,
        total,
        flag,
        placeholder: false
      });
    });

  // ---- TRUE TIED-RANK LOGIC ----
  rows.forEach((row, index) => {
    if (
      index > 0 &&
      row.gold === rows[index - 1].gold &&
      row.silver === rows[index - 1].silver &&
      row.bronze === rows[index - 1].bronze
    ) {
      row.rank = rows[index - 1].rank; // same rank as previous
    } else {
      row.rank = index + 1; // new rank
    }
  });

  return rows;
}

// ---- Main ----
async function main() {
  const { sourceUrl, html } = await fetchParsedHtml(GAME_PAGE);

  const topRows = parseTopRowsInDisplayOrder(html, TOP_N);
  const hasAnyMedals = topRows.some(r => (r.gold + r.silver + r.bronze) > 0);

  const finalRows =
    topRows.length === TOP_N
      ? topRows
      : buildPlaceholders(Math.max(PLACEHOLDER_COUNT, TOP_N)).slice(0, TOP_N);

  const now = new Date();

  // Force EST Timezone and get parts
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  // This will create a string like: "Feb 15, 2026, 07:14 PM"
  let parts = formatter.formatToParts(now);
  let d = parts.find(p => p.type === 'day').value;
  let m = parts.find(p => p.type === 'month').value;
  let y = parts.find(p => p.type === 'year').value;
  let hr = parts.find(p => p.type === 'hour').value;
  let min = parts.find(p => p.type === 'minute').value;
  let dayPeriod = parts.find(p => p.type === 'dayPeriod').value;

  // Final format: "15-Feb-2026 07:14 PM"
  const formattedDate = `${d}-${m}-${y} ${hr}:${min} ${dayPeriod}`;
  
  const payload = {
    updatedAt: formattedDate,
    source: "Wikipedia",
    sourceUrl,
    games: GAMES_NAME,
    gamePage: GAME_PAGE,
    isLiveData: hasAnyMedals,
    rows: finalRows
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Wrote ${OUT_FILE} top=${TOP_N} rows=${finalRows.length} live=${hasAnyMedals}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
