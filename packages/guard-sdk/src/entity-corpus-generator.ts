/**
 * The entity corpus generator: a seeded, deterministic writer of the main split of
 * `corpus/entities/` (person names, places and street addresses, span-annotated).
 *
 * Everything here is synthetic and licence-clean:
 * - Given names: a hand-picked subset of names in the US Social Security Administration's
 *   published baby-name lists (a US federal government work, public domain).
 * - Surnames: a hand-picked subset of names in the US Census Bureau's 2010 surname list
 *   (a US federal government work, public domain).
 * - News-style items name invented people with invented facts: no real person is named anywhere.
 * - US places: names in the US Census Bureau's gazetteer of places (public domain). Other cities,
 *   regions and countries: names of major places, used as plain geographic facts; no gazetteer
 *   dataset was copied.
 * - Street names, house numbers and postcodes: invented for this corpus (postcodes are only
 *   format-valid), written here by hand. Every sentence template is written here by hand.
 *
 * Items are written in a small markup, `⟦class|text⟧`, so the labelled spans are exact by
 * construction; `parseEntityMarkup` turns markup into text and character offsets.
 *
 * This file is self-contained (no relative imports, erasable TypeScript only), so Node runs it
 * directly:
 *   node packages/guard-sdk/src/entity-corpus-generator.ts --write          regenerate corpus/entities/main.json
 *   node packages/guard-sdk/src/entity-corpus-generator.ts --heldout <src>  convert a held-out markup source
 *   node packages/guard-sdk/src/entity-corpus-generator.ts --print <file>   show a corpus file as markup
 */

import { closeSync, constants, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ENTITY_CORPUS_FORMAT = "l2m.entity-corpus";
export const ENTITY_CORPUS_SEED = 20261117;
export const ENTITY_CORPUS_CLASS_NAMES = ["person_name", "location", "street_address"] as const;

export interface EntityMarkupItem {
  id: string;
  tags: string[];
  markup: string;
}

export interface EntityCorpusSpan {
  start: number;
  end: number;
  class: string;
}

export interface EntityCorpusDocumentItem {
  id: string;
  lang: string;
  tags: string[];
  textB64: string;
  entities: EntityCorpusSpan[];
}

export interface EntityCorpusDocument {
  format: string;
  version: number;
  split: "main" | "heldout";
  description: string;
  source: string;
  items: EntityCorpusDocumentItem[];
}

const OPEN = "⟦";
const CLOSE = "⟧";

/** Markup to text plus spans (UTF-16 offsets into the text). Throws on unknown classes, nesting or stray brackets. */
export function parseEntityMarkup(markup: string): { text: string; entities: EntityCorpusSpan[] } {
  let text = "";
  const entities: EntityCorpusSpan[] = [];
  let index = 0;
  while (index < markup.length) {
    const open = markup.indexOf(OPEN, index);
    const strayClose = markup.indexOf(CLOSE, index);
    if (open === -1) {
      if (strayClose !== -1) throw new Error(`Unbalanced ${CLOSE} at ${strayClose}`);
      text += markup.slice(index);
      break;
    }
    if (strayClose !== -1 && strayClose < open) throw new Error(`Unbalanced ${CLOSE} at ${strayClose}`);
    text += markup.slice(index, open);
    const close = markup.indexOf(CLOSE, open + 1);
    if (close === -1) throw new Error(`Unclosed ${OPEN} at ${open}`);
    const inner = markup.slice(open + 1, close);
    if (inner.includes(OPEN)) throw new Error(`Nested ${OPEN} at ${open}`);
    const bar = inner.indexOf("|");
    if (bar === -1) throw new Error(`Span at ${open} has no class`);
    const cls = inner.slice(0, bar);
    const value = inner.slice(bar + 1);
    if (!(ENTITY_CORPUS_CLASS_NAMES as readonly string[]).includes(cls)) throw new Error(`Unknown class '${cls}' at ${open}`);
    if (value.length === 0 || value.trim() !== value) throw new Error(`Span at ${open} is empty or has outer whitespace`);
    entities.push({ start: text.length, end: text.length + value.length, class: cls });
    text += value;
    index = close + 1;
  }
  return { text, entities };
}

/** Text plus spans back to markup (for reading a corpus file). */
export function entityMarkupOf(text: string, entities: readonly EntityCorpusSpan[]): string {
  let out = "";
  let at = 0;
  for (const span of [...entities].sort((a, b) => a.start - b.start)) {
    out += `${text.slice(at, span.start)}${OPEN}${span.class}|${text.slice(span.start, span.end)}${CLOSE}`;
    at = span.end;
  }
  return out + text.slice(at);
}

/** Markup items to a corpus document (text stored as base64 of UTF-8). */
export function entityCorpusDocument(split: "main" | "heldout", items: readonly EntityMarkupItem[], meta: { description: string; source: string }): EntityCorpusDocument {
  const seen = new Set<string>();
  return {
    format: ENTITY_CORPUS_FORMAT,
    version: 1,
    split,
    description: meta.description,
    source: meta.source,
    items: items.map((item) => {
      if (seen.has(item.id)) throw new Error(`Duplicate item id ${item.id}`);
      seen.add(item.id);
      let parsed: { text: string; entities: EntityCorpusSpan[] };
      try {
        parsed = parseEntityMarkup(item.markup);
      } catch (error) {
        throw new Error(`${item.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { id: item.id, lang: "en", tags: item.tags, textB64: Buffer.from(parsed.text, "utf8").toString("base64"), entities: parsed.entities };
    })
  };
}

// --- Seeded randomness ------------------------------------------------------------------------

/** mulberry32: a small, well-known 32-bit PRNG. Deterministic for a seed on every platform. */
function createRandom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  const chance = (p: number) => next() < p;
  const digits = (n: number) => Array.from({ length: n }, () => String(int(0, 9))).join("");
  const letters = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[int(0, alphabet.length - 1)]).join("");
  return { next, int, pick, chance, digits, letters };
}
type Random = ReturnType<typeof createRandom>;

// --- Lists (sources in the header) -------------------------------------------------------------

/** Subset of names in the US SSA baby-name lists (public domain). */
const GIVEN_NAMES = [
  "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara", "Susan", "Jessica", "Sarah", "Karen",
  "Nancy", "Lisa", "Margaret", "Sandra", "Ashley", "Emily", "Michelle", "Amanda", "Melissa", "Laura",
  "James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Charles",
  "Christopher", "Daniel", "Matthew", "Anthony", "Donald", "Steven", "Paul", "Andrew", "Joshua", "Kevin",
  "Priya", "Aisha", "Fatima", "Mateo", "Santiago", "Omar", "Ravi", "Mei", "Lucia", "Elena",
  "Noah", "Olivia", "Liam", "Sophia", "Ethan", "Chloe", "Isaac", "Naomi", "Gabriel", "Hannah"
] as const;

/** Given names that are also ordinary words or places; used with a cue so the name reading is clear. Also in the SSA lists. */
const AMBIGUOUS_GIVEN_NAMES = ["Will", "May", "Rose", "Grant", "Hope", "Mark", "Bill", "April", "Hunter", "Summer", "Jordan", "Dawn"] as const;

/** Subset of names in the US Census Bureau 2010 surname list (public domain). */
const SURNAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez",
  "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Taylor", "Moore", "Jackson", "Martin", "Lee",
  "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
  "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores", "Green",
  "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts", "Patel",
  "Kim", "Chen", "Singh", "Murphy", "O'Brien", "Kowalski", "Schmidt", "Fischer", "Novak", "Fitzgerald"
] as const;

/** Invented people with invented, neutral facts, written like news or history (no real person is named anywhere in the corpus). */
const NEWS_FIGURES: ReadonlyArray<readonly [string, string]> = [
  ["Edith Marlowe", "founded the town's first lending library in 1902"],
  ["Tobias Wren", "led the survey team that mapped the northern coast"],
  ["Celia Ashdown", "won the regional chess championship three years running"],
  ["Rupert Halloway", "opened the new bridge on Saturday, the council said"],
  ["Ines Carrow", "was appointed head of the hospital's research unit"],
  ["Oskar Lindqvist", "published a short history of the harbour in 1931"]
];

/** US places from the Census gazetteer, with their state codes. */
const US_CITIES: ReadonlyArray<readonly [string, string]> = [
  ["Springfield", "IL"], ["Portland", "OR"], ["Denver", "CO"], ["Austin", "TX"], ["Columbus", "OH"], ["Madison", "WI"],
  ["Albany", "NY"], ["Raleigh", "NC"], ["Tucson", "AZ"], ["Boise", "ID"], ["Omaha", "NE"], ["Savannah", "GA"]
];
const UK_TOWNS: ReadonlyArray<readonly [string, string]> = [
  ["Leeds", "LS"], ["Bristol", "BS"], ["York", "YO"], ["Norwich", "NR"], ["Cardiff", "CF"], ["Glasgow", "G"],
  ["Bath", "BA"], ["Exeter", "EX"], ["Oxford", "OX"], ["Cambridge", "CB"]
];
const CA_CITIES: ReadonlyArray<readonly [string, string, string]> = [
  ["Toronto", "ON", "M"], ["Ottawa", "ON", "K"], ["Calgary", "AB", "T"], ["Halifax", "NS", "B"],
  ["Winnipeg", "MB", "R"], ["Victoria", "BC", "V"], ["Regina", "SK", "S"], ["Montréal", "QC", "H"]
];
const AU_CITIES: ReadonlyArray<readonly [string, string, string]> = [
  ["Brisbane", "QLD", "4"], ["Perth", "WA", "6"], ["Adelaide", "SA", "5"], ["Hobart", "TAS", "7"],
  ["Geelong", "VIC", "3"], ["Newcastle", "NSW", "2"], ["Canberra", "ACT", "26"], ["Darwin", "NT", "08"]
];
const DE_CITIES = ["Berlin", "Hamburg", "Köln", "Leipzig", "Bremen", "Dresden", "Hannover", "Nürnberg"] as const;
const FR_CITIES: ReadonlyArray<readonly [string, string]> = [
  ["Lyon", "69"], ["Nantes", "44"], ["Lille", "59"], ["Rennes", "35"], ["Bordeaux", "33"], ["Toulouse", "31"], ["Dijon", "21"], ["Grenoble", "38"]
];
const STANDALONE_CITIES = [
  "Chicago", "Seattle", "Boston", "Manchester", "Edinburgh", "Vancouver", "Montreal", "Melbourne", "Sydney", "Munich",
  "Marseille", "Lisbon", "Nairobi", "Mumbai", "Singapore", "Osaka", "Dublin", "Madrid", "Toronto", "Leeds"
] as const;
const REGIONS = ["Ontario", "Bavaria", "Queensland", "Yorkshire", "Texas", "Brittany", "California", "Scotland", "Tasmania", "Alberta", "Normandy", "Oregon"] as const;
const COUNTRIES = ["France", "Germany", "Canada", "Kenya", "Portugal", "Australia", "Japan", "Brazil", "Ireland", "New Zealand", "Mexico", "Norway"] as const;

/** Invented street-name stems (written for this corpus). */
const STREET_STEMS = [
  "Larkspur", "Copperfield", "Willowmere", "Ashcombe", "Thornbury", "Elmstead", "Brackenridge", "Kestrel",
  "Foxglove", "Millbrook", "Harrowgate", "Quarry Hill", "Saltmarsh", "Birchwood", "Ivybridge", "Orchard",
  "Station", "Maple", "Cedar", "Juniper", "Wrenfield", "Highcliff", "Pebble Bay", "Lantern"
] as const;
const DE_STEMS = ["Linden", "Birken", "Garten", "Rosen", "Mühlen", "Kastanien", "Ahorn", "Schiller", "Wiesen", "Brunnen"] as const;
const DE_SUFFIXES = ["straße", "str.", "weg", "allee", "ring", "platz"] as const;
const FR_STREETS = ["rue des Lilas", "avenue du Moulin", "rue de la Fontaine", "boulevard des Tilleuls", "allée des Acacias", "rue du Port", "chemin de la Gare", "impasse des Vignes", "place du Marché", "rue des Écoles"] as const;

// --- Builders -------------------------------------------------------------------------------------

const NAME = (text: string) => `${OPEN}person_name|${text}${CLOSE}`;
const LOC = (text: string) => `${OPEN}location|${text}${CLOSE}`;
const ADDR = (text: string) => `${OPEN}street_address|${text}${CLOSE}`;

const UK_POSTCODE_LETTERS = "ABDEFGHJLNPQRSTUWXYZ";
const CA_POSTCODE_LETTERS = "ABCEGHJKLMNPRSTVWXYZ";

type Country = "us" | "uk" | "ca" | "au" | "de" | "fr";
const COUNTRIES_IN_SCOPE: readonly Country[] = ["us", "uk", "ca", "au", "de", "fr"];

/** One address, single-line or multi-line. */
function address(r: Random, country: Country, multiline: boolean): string {
  const sep = multiline ? "\n" : ", ";
  switch (country) {
    case "us": {
      const [city, state] = r.pick(US_CITIES);
      const type = r.pick(["Street", "St", "Avenue", "Ave", "Road", "Rd", "Drive", "Dr", "Lane", "Boulevard", "Court", "Way", "Place"]);
      const unit = r.chance(0.3) ? r.pick([`, Apt ${r.int(1, 30)}${r.pick(["A", "B", "C"])}`, ` Suite ${r.int(100, 950)}`, `, Unit ${r.int(1, 40)}`]) : "";
      const zip = `${r.int(1, 9)}${r.digits(4)}${r.chance(0.2) ? `-${r.digits(4)}` : ""}`;
      return `${r.int(10, 9899)} ${r.pick(STREET_STEMS)} ${type}${unit}${sep}${city}, ${state} ${zip}`;
    }
    case "uk": {
      const [town, area] = r.pick(UK_TOWNS);
      const type = r.pick(["Road", "Lane", "Street", "Close", "Avenue", "Gardens", "Crescent", "Way", "Terrace"]);
      const flat = r.chance(0.25) ? `Flat ${r.int(1, 12)}, ` : "";
      const postcode = `${area}${r.int(1, 28)} ${r.int(1, 9)}${r.letters(UK_POSTCODE_LETTERS, 2)}`;
      return multiline ? `${flat}${r.int(1, 240)} ${r.pick(STREET_STEMS)} ${type}\n${town}\n${postcode}` : `${flat}${r.int(1, 240)} ${r.pick(STREET_STEMS)} ${type}, ${town} ${postcode}`;
    }
    case "ca": {
      const [city, province, first] = r.pick(CA_CITIES);
      const type = r.pick(["Street", "Avenue", "Drive", "Road", "Crescent", "Boulevard"]);
      const unit = r.chance(0.3) ? r.pick([` Suite ${r.int(100, 900)}`, `, Unit ${r.int(1, 30)}`]) : "";
      const postal = `${first}${r.int(0, 9)}${r.letters(CA_POSTCODE_LETTERS, 1)} ${r.int(0, 9)}${r.letters(CA_POSTCODE_LETTERS, 1)}${r.int(0, 9)}`;
      return `${r.int(10, 9999)} ${r.pick(STREET_STEMS)} ${type}${unit}${sep}${city}, ${province} ${postal}`;
    }
    case "au": {
      const [city, state, prefix] = r.pick(AU_CITIES);
      const type = r.pick(["Street", "St", "Parade", "Crescent", "Road", "Avenue", "Terrace", "Place"]);
      const number = r.chance(0.3) ? `${r.int(1, 20)}/${r.int(2, 300)}` : String(r.int(1, 400));
      const postcode = `${prefix}${r.digits(4 - prefix.length)}`;
      const locality = multiline && r.chance(0.5) ? city.toUpperCase() : city;
      return `${number} ${r.pick(STREET_STEMS)} ${type}${multiline ? "\n" : ", "}${locality} ${state} ${postcode}`;
    }
    case "de": {
      const street = r.chance(0.2) ? `Am ${r.pick(["Mühlbach", "Stadtpark", "Lindenhof", "Kirchberg"])}` : `${r.pick(DE_STEMS)}${r.pick(DE_SUFFIXES)}`;
      const number = `${r.int(1, 180)}${r.chance(0.2) ? r.pick(["a", "b"]) : ""}`;
      const plz = `${r.int(1, 9)}${r.digits(4)}`;
      const country = r.chance(0.25) ? `${sep}Germany` : "";
      return `${street} ${number}${sep}${plz} ${r.pick(DE_CITIES)}${country}`;
    }
    case "fr": {
      const [city, department] = r.pick(FR_CITIES);
      const number = `${r.int(1, 180)}${r.chance(0.15) ? " bis" : ""}`;
      const cp = `${department}${r.digits(3)}`;
      const country = r.chance(0.25) ? `${sep}France` : "";
      return `${number} ${r.pick(FR_STREETS)}${sep}${cp} ${multiline && r.chance(0.5) ? city.toUpperCase() : city}${country}`;
    }
  }
}

const fullName = (r: Random) => `${r.pick(GIVEN_NAMES)}${r.chance(0.15) ? ` ${r.letters("ABCDEFGHJKLMNPRSTW", 1)}.` : ""} ${r.pick(SURNAMES)}`;

/** Address items: the address in a realistic setting, some with a recipient name. */
const ADDRESS_TEMPLATES: ReadonlyArray<{ tags: string[]; multiline: boolean | "any"; build: (r: Random, a: string) => string }> = [
  { tags: ["email", "shipping"], multiline: true, build: (r, a) => `Please ship the replacement to:\n${NAME(fullName(r))}\n${ADDR(a)}\nThanks!` },
  { tags: ["json", "form"], multiline: false, build: (r, a) => `{"customer_id": "c_${r.digits(5)}", "shipping_address": "${ADDR(a)}", "status": "pending"}` },
  { tags: ["note"], multiline: false, build: (_r, a) => `Delivery note: leave the parcel with the neighbour at ${ADDR(a)} if nobody answers.` },
  { tags: ["email"], multiline: "any", build: (_r, a) => `Our new office is at ${ADDR(a)}. Visitors sign in at reception.` },
  { tags: ["log"], multiline: false, build: (r, a) => `2026-11-0${r.int(1, 9)}T09:${r.int(10, 59)}:22Z INFO geocode ok address="${ADDR(a)}" latency_ms=${r.int(20, 300)}` },
  { tags: ["code", "comment"], multiline: false, build: (_r, a) => `// Fallback warehouse: ${ADDR(a)}\nconst FALLBACK_WAREHOUSE_ID = "wh-02";` },
  { tags: ["csv"], multiline: false, build: (r, a) => `order_id,name,address\n${r.digits(5)},${NAME(fullName(r))},"${ADDR(a)}"` },
  { tags: ["form"], multiline: true, build: (r, a) => `Billing address:\n${ADDR(a)}\nReference: INV-${r.digits(4)}` },
  { tags: ["chat"], multiline: false, build: (_r, a) => `I moved last month, my new address is ${ADDR(a)} - can you update my account?` },
  { tags: ["ticket"], multiline: "any", build: (r, a) => `Ticket #${r.digits(5)}: courier could not find ${ADDR(a)}. Customer ${NAME(fullName(r))} will call back.` },
  { tags: ["yaml"], multiline: false, build: (r, a) => `contact:\n  name: ${NAME(fullName(r))}\n  address: "${ADDR(a)}"\n  preferred: email` },
  { tags: ["invoice"], multiline: true, build: (r, a) => `INVOICE ${r.digits(6)}\nBill to:\n${NAME(fullName(r))}\n${ADDR(a)}\nAmount due: ${r.int(20, 900)}.00` }
];

const NAME_TEMPLATES: ReadonlyArray<{ tags: string[]; build: (r: Random) => string }> = [
  { tags: ["email", "cue"], build: (r) => `Dear ${NAME(r.pick(GIVEN_NAMES))},\n\nYour order has shipped and should arrive within three days.` },
  { tags: ["chat", "cue"], build: (r) => `Hi ${NAME(r.pick(GIVEN_NAMES))}, thanks for the quick reply!` },
  { tags: ["email", "cue"], build: (r) => `Kind regards,\n${NAME(fullName(r))}\nAccounts team` },
  { tags: ["form", "cue"], build: (r) => `Name: ${NAME(fullName(r))}\nPlan: Pro\nSeats: ${r.int(2, 40)}` },
  { tags: ["note", "cue"], build: (r) => `Patient: ${NAME(fullName(r))}, follow-up in two weeks.` },
  { tags: ["note", "title"], build: (r) => `Dr. ${NAME(r.pick(SURNAMES))} will review the results on Monday.` },
  { tags: ["note", "title"], build: (r) => `${r.pick(["Ms", "Mr", "Mrs", "Prof."])} ${NAME(r.pick(SURNAMES))} asked for a callback before noon.` },
  { tags: ["note", "nocue"], build: (r) => `${NAME(fullName(r))} joined the call late and asked about pricing.` },
  { tags: ["ticket", "nocue"], build: (r) => `Assigned to ${NAME(fullName(r))} (on call this week).` },
  { tags: ["notes", "list"], build: (r) => `Attendees: ${NAME(fullName(r))}, ${NAME(fullName(r))} and ${NAME(r.pick(GIVEN_NAMES))}.` },
  { tags: ["json"], build: (r) => `{"assignee": "${NAME(fullName(r))}", "priority": "high", "ticket": ${r.digits(4)}}` },
  { tags: ["note", "cue"], build: (r) => `Customer ${NAME(fullName(r))} called about a duplicate charge.` },
  { tags: ["email", "cue"], build: (r) => `cc: ${NAME(fullName(r))}\nSubject: quarterly numbers` },
  { tags: ["chat", "lookalike", "cue"], build: (r) => `Thanks, ${NAME(r.pick(AMBIGUOUS_GIVEN_NAMES))}! I'll take it from here.` },
  { tags: ["email", "lookalike", "cue"], build: (r) => `Dear ${NAME(r.pick(AMBIGUOUS_GIVEN_NAMES))},\nThe contract is attached.` },
  { tags: ["note", "lookalike"], build: (r) => `Ask ${NAME(`${r.pick(AMBIGUOUS_GIVEN_NAMES)} ${r.pick(SURNAMES)}`)} for the keys to the lab.` },
  { tags: ["news"], build: (r) => {
    const [name, fact] = r.pick(NEWS_FIGURES);
    return `${NAME(name)} ${fact}.`;
  } },
  { tags: ["email", "signoff"], build: (r) => `Let me know if anything is missing.\n\nBest,\n${NAME(r.pick(GIVEN_NAMES))}` }
];

const LOCATION_TEMPLATES: ReadonlyArray<{ tags: string[]; build: (r: Random) => string }> = [
  { tags: ["chat"], build: (r) => `I'm flying to ${LOC(r.pick(STANDALONE_CITIES))} on Tuesday for the workshop.` },
  { tags: ["note", "list"], build: (r) => {
    const [a, b, c] = [r.pick(STANDALONE_CITIES), r.pick(REGIONS), r.pick(COUNTRIES)];
    return `We now have customers in ${LOC(a)}, ${LOC(b)} and ${LOC(c)}.`;
  } },
  { tags: ["email"], build: (r) => `Shipping to ${LOC(r.pick(COUNTRIES))} takes 5-7 working days.` },
  { tags: ["note"], build: (r) => `The ${LOC(r.pick(REGIONS))} team owns the rollout this quarter.` },
  { tags: ["alert"], build: (r) => {
    const [city, state] = r.pick(US_CITIES);
    return `Weather alert for ${LOC(city)}, ${LOC(state === "OR" ? "Oregon" : state === "TX" ? "Texas" : state === "NY" ? "New York" : "Ohio")}: heavy rain expected tonight.`;
  } },
  { tags: ["news", "lookalike"], build: () => `Exports from ${LOC("Jordan")} rose last quarter.` },
  { tags: ["json"], build: (r) => `{"region": "${LOC(r.pick(REGIONS))}", "seats": ${r.int(5, 90)}}` },
  { tags: ["log"], build: (r) => `user login from ${LOC(r.pick(STANDALONE_CITIES))} (geo-ip estimate), session ${r.digits(6)}` },
  { tags: ["chat"], build: (r) => `Born in ${LOC(r.pick(STANDALONE_CITIES))}, now living in ${LOC(r.pick(STANDALONE_CITIES))}.` },
  { tags: ["note", "mixed"], build: (r) => `${NAME(fullName(r))} is relocating to ${LOC(r.pick(STANDALONE_CITIES))} in the spring.` }
];

/** Items with no labelled span: look-alikes of each class. */
const NEGATIVE_TEMPLATES: ReadonlyArray<{ tags: string[]; build: (r: Random) => string }> = [
  { tags: ["negative", "lookalike"], build: () => "The May release adds dark mode and fixes the export bug." },
  { tags: ["negative", "lookalike"], build: () => "Grant access to the reporting bucket before Friday." },
  { tags: ["negative", "lookalike"], build: (r) => `Bill #${r.digits(4)} is overdue; please pay by the 30th.` },
  { tags: ["negative", "lookalike"], build: () => "Will the build finish before the demo?" },
  { tags: ["negative", "lookalike"], build: () => "Mark the ticket resolved once QA signs off." },
  { tags: ["negative", "lookalike"], build: () => "Hope this helps! Ping me if the error comes back." },
  { tags: ["negative", "code"], build: (r) => `function mainStreetHandler(req) {\n  return route(req, "main_street_id", ${r.int(1, 9)});\n}` },
  { tags: ["negative", "code"], build: (r) => `SELECT ${r.pick(STREET_STEMS).toLowerCase().replace(/ /g, "_")}_street_id, zip FROM addresses WHERE zip IS NULL;` },
  { tags: ["negative", "version"], build: (r) => `Bumped the dependency to v${r.int(1, 9)}.${r.int(0, 30)}.${r.int(0, 9)} on the main branch.` },
  { tags: ["negative", "lookalike"], build: () => "Rented a Lincoln for the trip; it handled the snow fine." },
  { tags: ["negative", "product"], build: () => "Set the heading font to Paris Sans and the body to a monospace face." },
  { tags: ["negative", "postcode"], build: (r) => `ZIP ${r.int(1, 9)}${r.digits(4)} only - no street was given on the form.` },
  { tags: ["negative", "postcode"], build: (r) => `Postcode field: ${r.pick(UK_TOWNS)[1]}${r.int(1, 20)} ${r.int(1, 9)}${r.letters(UK_POSTCODE_LETTERS, 2)} (validated).` },
  { tags: ["negative", "pobox"], build: (r) => `Send cheques to PO Box ${r.digits(4)}.` },
  { tags: ["negative", "network"], build: (r) => `Blocked 203.0.113.${r.int(2, 250)} after 5 failed logins.` },
  { tags: ["negative", "street"], build: () => "Traffic on the high street is slow this morning; allow extra time." },
  { tags: ["negative", "phone"], build: (r) => `Call 555-01${r.digits(2)} to reschedule.` },
  { tags: ["negative"], build: (r) => `Order total: $${r.int(5, 400)}.${r.digits(2)}, ref INV-${r.digits(4)}.` },
  { tags: ["negative", "role"], build: () => "The customer asked for a refund and the agent approved it." },
  { tags: ["negative", "code"], build: () => "TZ=Europe/Berlin node server.js --port 8080" },
  { tags: ["negative", "email"], build: () => "Email support@example.com or open https://help.example.com/orders for status." },
  { tags: ["negative", "product"], build: (r) => `Rose gold finish, 128 GB, SKU ROSE-${r.digits(3)}.` },
  { tags: ["negative", "lookalike"], build: () => "April totals are in the dashboard; March is still loading." },
  { tags: ["negative", "product"], build: () => "Hunter mode turns on aggressive caching for the image service." },
  { tags: ["negative", "units"], build: (r) => `Service due at ${r.int(20, 90)},000 km; tyre pressure 2.${r.int(1, 6)} bar.` },
  { tags: ["negative", "code"], build: (r) => `const street = parseStreet(input); // returns null for "${r.int(1, 99)}"` },
  { tags: ["negative", "log"], build: (r) => `GET /api/addresses/${r.digits(6)} 404 ${r.int(2, 40)}ms` },
  { tags: ["negative", "lookalike"], build: () => "Summer pricing ends on the first of September." },
  { tags: ["negative", "lookalike"], build: () => "Dawn patrol: the backup job runs at 5 a.m. every day." },
  { tags: ["negative", "role"], build: () => "Thanks, team! The release notes are ready for review." },
  { tags: ["negative", "lookalike"], build: () => "The new Orchard Lane theme ships with three colour palettes." },
  { tags: ["negative", "lookalike"], build: () => "Bill and pay the remaining balance through the portal." },
  { tags: ["negative", "lookalike"], build: () => "We will review the grant proposal next week." },
  { tags: ["negative", "product"], build: () => "The Phoenix dashboard now loads twice as fast." },
  { tags: ["negative", "code"], build: () => "git checkout -b fix/lane-closure-validation" },
  { tags: ["negative", "code"], build: () => "export const DEFAULT_STREET_TYPE = 'avenue';" },
  { tags: ["negative", "lookalike"], build: () => "Rose by 12% compared with last quarter." },
  { tags: ["negative", "lookalike"], build: () => "Sales may dip in the holiday week." },
  { tags: ["negative", "lookalike"], build: () => "Victoria sponge and coffee will be served at the offsite." },
  { tags: ["negative", "product"], build: () => "Upgrade to the Everest plan for unlimited seats." },
  { tags: ["negative", "role"], build: () => "Please ask the account owner to approve the invoice." },
  { tags: ["negative", "role"], build: () => "The driver left the package at the front desk." },
  { tags: ["negative", "units"], build: () => "Average delivery time fell to 2.4 days last month." },
  { tags: ["negative", "code"], build: () => "def normalise_postcode(value: str) -> str:\n    return value.replace(' ', '').upper()" },
  { tags: ["negative", "log"], build: () => "WARN address lookup skipped: empty input (request 7731)" },
  { tags: ["negative", "street"], build: () => "Turn left at the second roundabout and follow the signs for parking." },
  { tags: ["negative", "lookalike"], build: () => "Our Main Street pricing tier is aimed at small shops." },
  { tags: ["negative", "lookalike"], build: () => "Hunter green and navy are the two brand colours." },
  { tags: ["negative", "lookalike"], build: () => "Will do - I'll send it over after lunch." },
  { tags: ["negative", "product"], build: () => "The Atlas release candidate passed every smoke test." },
  { tags: ["negative", "network"], build: () => "Resolved api.example.com to 198.51.100.17 in 12 ms." },
  { tags: ["negative", "role"], build: () => "Our support lead will reply to the escalation today." },
  { tags: ["negative", "units"], build: () => "Room 4.12 is booked from 2 pm to 4 pm." },
  { tags: ["negative", "lookalike"], build: () => "Mark down the clearance items by 30% on Friday." },
  { tags: ["negative", "email"], build: () => "Unsubscribe at any time from the link in the footer." },
  { tags: ["negative", "lookalike"], build: () => "Grace period for late payments is seven days." },
  { tags: ["negative", "code"], build: () => "curl -X POST https://api.example.com/v2/geocode -d '{}'" },
  { tags: ["negative", "lookalike"], build: () => "Nobody signed for the parcel, so it went back to the depot." },
  { tags: ["negative", "lookalike"], build: () => "Ivy covers the north wall of the warehouse." },
  { tags: ["negative", "product"], build: () => "Download the Sierra template from the shared drive." },
  { tags: ["negative", "lookalike"], build: () => "Dawn and dusk shots look best for the catalogue." },
  { tags: ["negative", "units"], build: () => "Shipment weight: 14.2 kg, 3 boxes, fragile." }
];

/** The main split: 96 address items (16 per country), 80 name items, 60 location items and 64 negatives. */
export function generateMainEntityItems(seed: number = ENTITY_CORPUS_SEED): EntityMarkupItem[] {
  const r = createRandom(seed);
  const items: Array<{ tags: string[]; markup: string }> = [];
  const texts = new Set<string>();
  /** Adds one item from the template list, starting at `index`; a repeated text is drawn again, then the next template is tried. */
  const add = <T extends { tags: string[] }>(templates: readonly T[], index: number, extraTags: string[], build: (template: T) => string) => {
    for (let offset = 0; offset < templates.length; offset += 1) {
      const template = templates[(index + offset) % templates.length]!;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const markup = build(template);
        if (texts.has(markup)) continue;
        texts.add(markup);
        items.push({ tags: [...template.tags, ...extraTags], markup });
        return;
      }
    }
    throw new Error("The generator ran out of distinct items");
  };
  for (const country of COUNTRIES_IN_SCOPE) {
    for (let index = 0; index < 16; index += 1) {
      add(ADDRESS_TEMPLATES, index + COUNTRIES_IN_SCOPE.indexOf(country), [country, "address"], (template) =>
        template.build(r, address(r, country, template.multiline === "any" ? r.chance(0.5) : template.multiline))
      );
    }
  }
  for (let index = 0; index < 80; index += 1) add(NAME_TEMPLATES, index, ["name"], (template) => template.build(r));
  for (let index = 0; index < 60; index += 1) add(LOCATION_TEMPLATES, index, ["location"], (template) => template.build(r));
  for (let index = 0; index < 64; index += 1) add(NEGATIVE_TEMPLATES, index, [], (template) => template.build(r));
  return items.map((item, index) => ({ id: `en-m-${String(index + 1).padStart(3, "0")}`, ...item }));
}

export const MAIN_ENTITY_CORPUS_SOURCE =
  "Generated by packages/guard-sdk/src/entity-corpus-generator.ts (seed 20261117). Given names: subset of the US SSA baby-name lists; surnames: subset of the US Census Bureau 2010 surname list (both US government works, public domain). US places: US Census gazetteer names (public domain); other places: names of major cities, regions and countries as plain geographic facts. Streets, numbers and postcodes are invented (postcodes are format-valid only). News-style items name invented people; no real person is named. Templates are hand-written.";

export const MAIN_ENTITY_CORPUS_DESCRIPTION =
  "Main split: person names, places and street addresses (US, UK, CA, AU, DE, FR) in English text, with look-alikes that must not be flagged.";

/** The corpus folder that ships with guard-sdk. */
export function entityCorpusFolder(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "corpus", "entities");
}

/** Write a corpus file; never through a symbolic link. */
function writeCorpusFile(target: string, text: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(target).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (isLink) throw new Error(`Refusing to write through the symbolic link ${target}`);
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

function serialise(document: EntityCorpusDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The committed main split, as the generator writes it. */
export function mainEntityCorpusText(seed: number = ENTITY_CORPUS_SEED): string {
  return serialise(entityCorpusDocument("main", generateMainEntityItems(seed), { description: MAIN_ENTITY_CORPUS_DESCRIPTION, source: MAIN_ENTITY_CORPUS_SOURCE }));
}

/** A held-out markup source (`[{ id, tags, markup }]`) as a corpus document. */
export function heldoutEntityCorpusText(source: unknown, meta: { description: string; source: string }): string {
  if (!Array.isArray(source)) throw new Error("The held-out source must be a JSON array of { id, tags, markup }");
  const items = source.map((entry, index) => {
    const value = entry as Partial<EntityMarkupItem>;
    if (typeof value.id !== "string" || typeof value.markup !== "string") throw new Error(`Held-out source entry ${index} needs an id and markup`);
    return { id: value.id, tags: Array.isArray(value.tags) ? value.tags.map(String) : [], markup: value.markup };
  });
  return serialise(entityCorpusDocument("heldout", items, meta));
}

function runCli(argv: string[]): void {
  const [command, file] = argv;
  if (command === "--write") {
    const target = join(entityCorpusFolder(), "main.json");
    writeCorpusFile(target, mainEntityCorpusText());
    process.stdout.write(`Wrote ${target}\n`);
    return;
  }
  if (command === "--heldout" && file) {
    const target = join(entityCorpusFolder(), "heldout", "heldout.json");
    const meta = JSON.parse(readFileSync(join(entityCorpusFolder(), "heldout", "heldout.meta.json"), "utf8")) as { description: string; source: string };
    writeCorpusFile(target, heldoutEntityCorpusText(JSON.parse(readFileSync(file, "utf8")) as unknown, meta));
    process.stdout.write(`Wrote ${target}\n`);
    return;
  }
  if (command === "--print" && file) {
    const document = JSON.parse(readFileSync(file, "utf8")) as EntityCorpusDocument;
    for (const item of document.items) {
      process.stdout.write(`--- ${item.id} [${item.tags.join(", ")}]\n${entityMarkupOf(Buffer.from(item.textB64, "base64").toString("utf8"), item.entities)}\n`);
    }
    return;
  }
  process.stderr.write("Usage: node entity-corpus-generator.ts --write | --heldout <source.json> | --print <corpus file>\n");
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli(process.argv.slice(2));
