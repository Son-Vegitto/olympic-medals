// scripts/buildNocMappings.js
import fs from "node:fs";
import path from "node:path";
import { load } from "cheerio";

/**
 * Generates:
 *  - scripts/name_to_noc.json  (Name -> NOC)
 *  - scripts/noc_to_iso2.json  (NOC -> ISO2, for FlagCDN PNGs)
 *
 * Sources:
 *  - NOC + country/committee names: Wikipedia "List of IOC country codes"
 *  - ISO2 mapping: best-effort via Wikipedia country pages / known overrides
 *
 * NOTE:
 *  - Some NOCs are NOT sovereign states (e.g., Puerto Rico, Hong Kong, Aruba, etc.)
 *  - Some "teams" (AIN, EOR, etc.) do not have ISO2 flags; we handle with placeholders.
 */

const OUT_DIR = "scripts";
const OUT_NAME_TO_NOC = path.join(OUT_DIR, "name_to_noc.json");
const OUT_NOC_TO_ISO2 = path.join(OUT_DIR, "noc_to_iso2.json");

// Wikipedia page with current NOCs table
const IOC_CODES_PAGE = "List_of_IOC_country_codes";

// Flag fallback for neutral teams (put your own PNGs in /flags if you want)
const NEUTRAL_NOC_ISO2_OVERRIDES = {
  // Neutral/temporary teams often have no ISO2. Leave null so your widget can use a fallback image.
  AIN: null,
  EOR: null,
  IOA: null,
  OLY: null,
  ROT: null
};

// Known NOC -> ISO2 exceptions where NOC != ISO2 or the name lookup can be ambiguous
// (This list is small; everything else is derived.)
const NOC_TO_ISO2_OVERRIDES = {
  GER: "de",
  SUI: "ch",
  GRE: "gr",
  DEN: "dk",
  UAE: "ae",
  KSA: "sa",
  RSA: "za",
  POR: "pt",
  ESP: "es",
  NED: "nl",
  AUT: "at",
  SLO: "si",
  SVK: "sk",
  CZE: "cz",
  ROU: "ro",
  BUL: "bg",
  CRO: "hr",
  HUN: "hu",
  LAT: "lv",
  LTU: "lt",
  EST: "ee",
  UKR: "ua",
  BLR: "by",
  ROC: "ru", // historical; if you don’t want it, remove
  TPE: "tw", // Chinese Taipei
  HKG: "hk",
  MAC: "mo",
  PUR: "pr",
  ISV: "vi", // US Virgin Islands
  IVB: "vg", // British Virgin Islands
  ASA: "as", // American Samoa
  GUM: "gu", // Guam
  MRI: "mh", // Marshall Islands
  FSM: "fm", // Micronesia
  PLW: "pw", // Palau
  NMI: "mp", // Northern Mariana Islands
  AHO: null // old; if encountered
};

async function fetchParsedHtml(pageTitle) {
  const apiUrl =
    "https://en.wikipedia.org/w/api.php" +
    `?action=parse&format=json&prop=text&formatversion=2&redirects=1&origin=*` +
    `&page=${encodeURIComponent(pageTitle)}`;

  const res = await fetch(apiUrl, {
    headers: { "User-Agent": "olympics-medals-widget/1.0 (GitHub Actions)" }
  });
  if (!res.ok) throw new Error(`Failed MediaWiki API: ${res.status} ${res.statusText}`);

  const data = await res.json();
  const html = data?.parse?.text;
  if (!html) throw new Error("Missing HTML in MediaWiki parse response");
  return html;
}

function normName(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();
}

function addNameAlias(map, name, noc) {
  const n = normName(name);
  if (!n) return;
  map[n] = noc;

  // Common aliases Widgy users run into
  map[n.replace(/\*+$/g, "").trim()] = noc; // "Italy*" -> "Italy"
  map[n.replace(/^The\s+/i, "")] = noc;     // "The Bahamas" -> "Bahamas"
}

function guessIso2FromNocOrName(noc, name) {
  // 1) hard overrides first
  if (noc in NEUTRAL_NOC_ISO2_OVERRIDES) return NEUTRAL_NOC_ISO2_OVERRIDES[noc];
  if (noc in NOC_TO_ISO2_OVERRIDES) return NOC_TO_ISO2_OVERRIDES[noc];

  // 2) if NOC is exactly 2 letters (rare), it might already be ISO2
  if (/^[A-Z]{2}$/.test(noc)) return noc.toLowerCase();

  // 3) last resort: try to infer ISO2 from the *country name* by checking common cases.
  // This is intentionally conservative: if we can't infer, return null and use fallback flag.
  // You can extend this with more cases over time.
  const n = normName(name).toLowerCase();

  const NAME_TO_ISO2_LIGHT = {
    "united states": "us",
    "united kingdom": "gb",
    "great britain": "gb",
    "russia": "ru",
    "china": "cn",
    "hong kong": "hk",
    "macao": "mo",
    "chinese taipei": "tw",
    "south korea": "kr",
    "north korea": "kp",
    "czechia": "cz",
    "czech republic": "cz",
    "ivory coast": "ci",
    "côte d'ivoire": "ci",
    "cape verde": "cv",
    "republic of ireland": "ie",
    "iran": "ir",
    "syria": "sy",
    "türkiye": "tr",
    "turkey": "tr",
    "vietnam": "vn",
    "laos": "la",
    "bolivia": "bo",
    "venezuela": "ve",
    "tanzania": "tz",
    "dominican republic": "do",
    "trinidad and tobago": "tt",
    "saint kitts and nevis": "kn",
    "saint vincent and the grenadines": "vc",
    "antigua and barbuda": "ag",
    "saint lucia": "lc",
    "united arab emirates": "ae",
    "saudi arabia": "sa",
    "south africa": "za",
    "netherlands": "nl",
    "switzerland": "ch",
    "germany": "de",
    "austria": "at",
    "spain": "es",
    "portugal": "pt",
    "greece": "gr",
    "denmark": "dk"
  };

  if (n in NAME_TO_ISO2_LIGHT) return NAME_TO_ISO2_LIGHT[n];

  // If the name is a simple country and NOC matches ISO3 country code,
  // we *could* use a lookup API — but we keep it offline-friendly.
  return null;
}

async function main() {
  const html = await fetchParsedHtml(IOC_CODES_PAGE);
  const $ = load(html);

  // Find the "Current NOCs" table: it contains "Code" and "National Olympic Committee"
  let nocTable = null;
  $("table.wikitable").each((_, t) => {
    const header = $(t).find("tr").first().text().toLowerCase();
    if (header.includes("code") && header.includes("national olympic committee")) {
      nocTable = t;
      return false;
    }
  });

  if (!nocTable) {
    throw new Error("Could not find the Current NOCs table on the IOC codes page.");
  }

  const nameToNoc = {};
  const nocToIso2 = {};

  $(nocTable)
    .find("tr")
    .slice(1)
    .each((_, tr) => {
      const tds = $(tr).find("td, th");
      if (tds.length < 2) return;

      const code = normName($(tds[0]).text()).toUpperCase();
      const committee = normName($(tds[1]).text());

      // Skip blanks
      if (!code || !/^[A-Z]{3}$/.test(code)) return;
      if (!committee) return;

      // Committee column often begins with the country/territory name
      // Example: "Afghanistan" or "Hong Kong, China" etc.
      // Use the first link text if available for a cleaner name.
      const firstLink = normName($(tds[1]).find('a[href^="/wiki/"]').first().text());
      const displayName = firstLink || committee;

      addNameAlias(nameToNoc, displayName, code);
      addNameAlias(nameToNoc, committee, code);

      const iso2 = guessIso2FromNocOrName(code, displayName);
      if (iso2) nocToIso2[code] = iso2;
    });

  // Ensure output dir exists
  fs.mkdirSync(OUT_DIR, { recursive: true });

  fs.writeFileSync(OUT_NAME_TO_NOC, JSON.stringify(nameToNoc, null, 2), "utf8");
  fs.writeFileSync(OUT_NOC_TO_ISO2, JSON.stringify(nocToIso2, null, 2), "utf8");

  console.log(`Wrote ${OUT_NAME_TO_NOC} (${Object.keys(nameToNoc).length} keys)`);
  console.log(`Wrote ${OUT_NOC_TO_ISO2} (${Object.keys(nocToIso2).length} keys)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
