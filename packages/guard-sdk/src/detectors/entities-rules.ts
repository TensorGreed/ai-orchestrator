import {
  AMBIGUOUS_PLACES,
  AU_STATES,
  CA_PROVINCES,
  CITIES,
  COUNTRIES,
  DE_STREET_SUFFIXES,
  DIRECTIONS,
  FR_PARTICLES,
  FR_STREET_TYPES,
  GIVEN_NAMES,
  NAME_LABELS,
  NAME_PARTICLES,
  NAME_PHRASES,
  NAME_TITLES,
  NOT_NAME_WORDS,
  PLACE_LABELS,
  PLACE_PREPOSITIONS,
  SALUTATIONS,
  SIGN_OFFS,
  STREET_TYPES,
  STRONG_PLACE_PHRASES,
  SURNAMES,
  UNIT_WORDS,
  US_STATES,
  WEAK_PLACE_PREPOSITIONS
} from "./entities-gazetteer";

/**
 * The rule-based entity recognizer's engine: a single pass over the text's tokens, no backtracking regular
 * expressions (the token pattern and the postcode patterns are flat, each with one bounded quantifier), so time is
 * linear in the text.
 *
 * - Street addresses: a house number, street name words and a street type (US, UK, CA, AU), or the German
 *   (`Hauptstraße 5`) and French (`12 rue de la Paix`) order, with an optional unit. A following locality with a
 *   postcode in the country's format (US state and ZIP, Canadian province and `A1A 1A1`, Australian state and four
 *   digits, a UK postcode, a German or French five-digit code and town) raises the score. A postcode alone is never
 *   reported.
 * - Person names: only with a cue (a title, a field label such as `Patient:`, a greeting, a sign-off line, a phrase
 *   such as `my name is`), or a listed given name followed by a listed surname.
 * - Locations: listed countries, US states and cities after a place cue (`in`, `from`, `based in`, a `City:` label);
 *   a listed place without a cue scores low, and a place that is also a common name or word (`Jordan`, `Nice`) needs
 *   a strong cue.
 */

export const RULE_ENTITY_RECOGNIZER_VERSION = "rules-1";

export interface RuleEntitySpan {
  start: number;
  end: number;
  dataClass: "person_name" | "location" | "street_address";
  score: number;
  source: string;
  /** A name found through a cue (title, label, greeting, sign-off, phrase). */
  cue?: boolean;
}

type TokenKind = "w" | "n" | "nl" | "p";

interface Token {
  text: string;
  lower: string;
  start: number;
  end: number;
  kind: TokenKind;
}

/** Words (letters, then letters, marks, apostrophes and hyphens), numbers with an optional letter suffix, line breaks, and single other characters. */
export const ENTITY_TOKEN_PATTERN = /\p{L}[\p{L}\p{M}'’-]{0,39}|\d{1,10}[A-Za-z]{0,3}|\n|[^\s\p{L}\d]/gu;
/** UK postcode (`SW1A 2AA`, `M1 1AE`), read at a token's start. */
export const UK_POSTCODE_PATTERN = /[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}(?![A-Za-z\d])/y;
/** Canadian postcode (`K1A 0B1`), read at a token's start. */
export const CA_POSTCODE_PATTERN = /[A-Z]\d[A-Z] ?\d[A-Z]\d(?![A-Za-z\d])/y;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  ENTITY_TOKEN_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(ENTITY_TOKEN_PATTERN)) {
    const value = match[0];
    const start = match.index ?? 0;
    const first = value.charCodeAt(0);
    const kind: TokenKind = value === "\n" ? "nl" : first >= 48 && first <= 57 ? "n" : /\p{L}/u.test(value[0]!) ? "w" : "p";
    tokens.push({ text: value, lower: value.toLowerCase(), start, end: start + value.length, kind });
  }
  return tokens;
}

const UPPER = /^\p{Lu}/u;
const HAS_LOWER = /\p{Ll}/u;
const ORDINAL = /^\d{1,3}(?:st|nd|rd|th)$/i;
const HOUSE_NUMBER = /^\d{1,6}[A-Za-z]?$/;
const DE_HOUSE_NUMBER = /^\d{1,4}[a-z]?$/;

function phraseSet(list: readonly string[]): { phrases: Set<string>; longest: number } {
  return { phrases: new Set(list), longest: Math.max(...list.map((phrase) => phrase.split(" ").length)) };
}

const NAME_LABEL_SET = phraseSet(NAME_LABELS);
const PLACE_LABEL_SET = phraseSet(PLACE_LABELS);
const ADDRESS_LABEL_SET = phraseSet(["address", "street", "street address", "home address", "mailing address", "postal address", "billing address", "shipping address", "delivery address", "addr", "residential address", "adresse", "anschrift"]);
const SIGN_OFF_SET = phraseSet(SIGN_OFFS);
const NAME_PHRASE_SET = phraseSet(NAME_PHRASES);
const STRONG_PLACE_SET = phraseSet(STRONG_PLACE_PHRASES);

/** Listed places by their lower-case words, longest first when matching. */
const PLACES = new Map<string, { ambiguous: boolean }>();
for (const name of [...COUNTRIES, ...CITIES, ...Object.values(US_STATES)]) {
  PLACES.set(name.toLowerCase(), { ambiguous: AMBIGUOUS_PLACES.has(name) });
}
const PLACE_MAX_WORDS = Math.max(...[...PLACES.keys()].map((key) => key.split(" ").length));
const US_STATE_NAMES = new Map(Object.values(US_STATES).map((name) => [name.toLowerCase(), name]));
const US_STATE_NAME_MAX_WORDS = Math.max(...Object.values(US_STATES).map((name) => name.split(" ").length));
const GIVEN_LOWER = new Set([...GIVEN_NAMES].map((name) => name.toLowerCase()));
const SURNAME_LOWER = new Set([...SURNAMES].map((name) => name.toLowerCase()));

export interface RuleRecognizeOptions {
  classes: ReadonlySet<string>;
}

/** Entity spans in one text (overlaps resolved: higher score, then longer, wins). */
export function recognizeEntitiesByRules(text: string, options: RuleRecognizeOptions): RuleEntitySpan[] {
  const tokens = tokenize(text);
  const spans: RuleEntitySpan[] = [];
  const want = options.classes;
  const t = (index: number): Token | undefined => tokens[index];
  const isWord = (index: number) => t(index)?.kind === "w";
  const isPunct = (index: number, value: string) => t(index)?.kind === "p" && t(index)!.text === value;
  /** Tokens `a` and `b` touch (no space between). */
  const touching = (a: number, b: number) => Boolean(t(a) && t(b) && t(a)!.end === t(b)!.start);

  /** The lower-case phrase made of the `n` words ending at `end` (inclusive), or undefined when a non-word is in between. */
  const wordsEndingAt = (end: number, n: number): string | undefined => {
    if (end - n + 1 < 0) return undefined;
    const parts: string[] = [];
    for (let i = end - n + 1; i <= end; i += 1) {
      const token = t(i);
      if (!token || token.kind !== "w") return undefined;
      parts.push(token.lower);
    }
    return parts.join(" ");
  };
  const phraseEndsAt = (end: number, set: { phrases: Set<string>; longest: number }): boolean => {
    for (let n = 1; n <= set.longest; n += 1) {
      const phrase = wordsEndingAt(end, n);
      if (phrase === undefined) return false;
      if (set.phrases.has(phrase)) return true;
    }
    return false;
  };

  // Names ------------------------------------------------------------------------------------------------------

  const nameWord = (token: Token | undefined): boolean => {
    if (!token || token.kind !== "w" || !UPPER.test(token.text) || token.text.length > 30) return false;
    const bare = token.text.replace(/['’]s$/u, "");
    if (NOT_NAME_WORDS.has(bare) || NAME_TITLES.has(bare) || STREET_TYPES.has(bare)) return false;
    // All capitals: an initialism (ACME, USA) unless it is a listed name.
    if (!HAS_LOWER.test(bare) && bare.length > 1 && !GIVEN_LOWER.has(bare.toLowerCase()) && !SURNAME_LOWER.has(bare.toLowerCase())) return false;
    return true;
  };

  interface NameRead {
    start: number;
    end: number;
    words: number;
    next: number;
    first: Token;
    last: Token;
  }

  const readName = (from: number, maxWords: number): NameRead | null => {
    let j = from;
    let words = 0;
    let end = -1;
    let first: Token | undefined;
    let last: Token | undefined;
    while (j < tokens.length && words < maxWords) {
      const token = tokens[j]!;
      if (nameWord(token)) {
        // A one-letter word is an initial only with its dot (`J.`) or as the last word.
        if (token.text.length === 1) {
          if (!(isPunct(j + 1, ".") && touching(j, j + 1))) break;
          words += 1;
          first ??= token;
          last = token;
          end = tokens[j + 1]!.end;
          j += 2;
          continue;
        }
        words += 1;
        first ??= token;
        last = token;
        end = token.end - (/['’]s$/u.test(token.text) ? 2 : 0);
        j += 1;
        if (/['’]s$/u.test(token.text)) break;
        continue;
      }
      if (words > 0 && token.kind === "w" && NAME_PARTICLES.has(token.text) && nameWord(t(j + 1))) {
        j += 1;
        continue;
      }
      break;
    }
    if (words === 0 || !first || !last) return null;
    return { start: first.start, end, words, next: j, first, last };
  };
  /** The token after a name ends a phrase: punctuation, a line break or the end of the text. */
  const endsPhrase = (index: number) => !t(index) || t(index)!.kind === "nl" || t(index)!.kind === "p";

  const addName = (read: NameRead, score: number, source: string, cue: boolean) => {
    spans.push({ start: read.start, end: read.end, dataClass: "person_name", score, source, cue });
  };

  if (want.has("person_name")) {
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.kind === "w") {
        // Titles: `Dr. Ana Diaz`, `Mr Smith`.
        if (NAME_TITLES.has(token.text)) {
          const after = isPunct(i + 1, ".") && touching(i, i + 1) ? i + 2 : i + 1;
          const read = readName(after, 3);
          if (read) addName(read, 0.9, "rules:title", true);
        }
        // Greetings: `Dear Ana,`, `Hi Tom Lee`.
        if (SALUTATIONS.has(token.text)) {
          const read = readName(i + 1, 3);
          if (read && (read.words >= 2 || endsPhrase(read.next))) addName(read, 0.85, "rules:greeting", true);
        }
        // Phrases: `my name is Ana Diaz`, `assigned to Tom Lee`.
        if (phraseEndsAt(i, NAME_PHRASE_SET)) {
          const read = readName(i + 1, 3);
          if (read && (read.words >= 2 || GIVEN_LOWER.has(read.first.lower))) addName(read, 0.8, "rules:phrase", true);
        }
        // Listed given name and surname: `Maria Garcia`.
        if (GIVEN_LOWER.has(token.lower) && UPPER.test(token.text)) {
          const read = readName(i, 3);
          if (read && read.first === token) {
            if (read.words >= 2) addName(read, SURNAME_LOWER.has(read.last.lower.replace(/['’]s$/u, "")) ? 0.8 : 0.7, "rules:list", false);
            else addName(read, 0.6, "rules:list", false);
          }
        }
      }
      // Field labels: `Patient: Ana Diaz`.
      if (token.kind === "p" && token.text === ":" && phraseEndsAt(i - 1, NAME_LABEL_SET)) {
        const read = readName(i + 1, 4);
        if (read) addName(read, 0.9, "rules:label", true);
      }
      // Sign-offs: `Best regards,\nAna Diaz`.
      if ((i === 0 || tokens[i - 1]!.kind === "nl" || isPunct(i - 1, ".") || isPunct(i - 1, "!")) && token.kind === "w") {
        let j = i;
        while (isWord(j) && j - i < SIGN_OFF_SET.longest) j += 1;
        if (j > i && SIGN_OFF_SET.phrases.has(wordsEndingAt(j - 1, j - i) ?? "")) {
          let k = j;
          if (isPunct(k, ",") || isPunct(k, ".") || isPunct(k, "!")) k += 1;
          if (t(k)?.kind === "nl") {
            k += 1;
            if (t(k)?.kind === "nl") k += 1;
            const read = readName(k, 4);
            if (read && endsPhrase(read.next)) addName(read, 0.85, "rules:sign-off", true);
          }
        }
      }
    }
  }

  // Locations --------------------------------------------------------------------------------------------------

  interface PlaceRead {
    start: number;
    end: number;
    next: number;
    listed: boolean;
    ambiguous: boolean;
  }

  /** A listed place starting at `from` (the longest listed name), or, when `anyCapitalised`, one to three capitalised words. */
  const readPlace = (from: number, anyCapitalised: boolean): PlaceRead | null => {
    const first = t(from);
    if (!first || first.kind !== "w" || !UPPER.test(first.text)) return null;
    for (let n = Math.min(PLACE_MAX_WORDS, tokens.length - from); n >= 1; n -= 1) {
      const phrase = wordsEndingAt(from + n - 1, n);
      if (phrase === undefined) continue;
      const entry = PLACES.get(phrase);
      if (entry && UPPER.test(t(from + n - 1)!.text)) return { start: first.start, end: t(from + n - 1)!.end, next: from + n, listed: true, ambiguous: entry.ambiguous };
    }
    if (!anyCapitalised) return null;
    let j = from;
    while (j < from + 3 && t(j)?.kind === "w" && UPPER.test(t(j)!.text) && !NOT_NAME_WORDS.has(t(j)!.text)) j += 1;
    if (j === from) return null;
    return { start: first.start, end: t(j - 1)!.end, next: j, listed: false, ambiguous: false };
  };

  /** `Springfield, IL`, `Paris, France`: a region or country after a comma extends the place. */
  const extendRegion = (read: PlaceRead): PlaceRead => {
    if (!isPunct(read.next, ",")) return read;
    const at = read.next + 1;
    const code = t(at);
    if (code?.kind === "w" && (US_STATES[code.text] !== undefined || CA_PROVINCES.has(code.text) || AU_STATES.has(code.text))) {
      return { ...read, end: code.end, next: at + 1, listed: true };
    }
    const region = readPlace(at, false);
    if (region && !region.ambiguous) return { ...read, end: region.end, next: region.next, listed: true };
    return read;
  };

  const addPlace = (read: PlaceRead, score: number, source: string) => {
    spans.push({ start: read.start, end: read.end, dataClass: "location", score, source });
  };

  if (want.has("location")) {
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.kind === "p" && token.text === ":" && phraseEndsAt(i - 1, PLACE_LABEL_SET)) {
        const read = readPlace(i + 1, true);
        if (read) addPlace(extendRegion(read), 0.85, "rules:label");
        continue;
      }
      if (token.kind !== "w" || !UPPER.test(token.text)) continue;
      const previous = t(i - 1);
      const strongPhrase = phraseEndsAt(i - 1, STRONG_PLACE_SET);
      const preposition = previous?.kind === "w" && PLACE_PREPOSITIONS.has(previous.text);
      const weak = previous?.kind === "w" && WEAK_PLACE_PREPOSITIONS.has(previous.text);
      const read = readPlace(i, strongPhrase);
      if (!read) continue;
      const extended = extendRegion(read);
      if (strongPhrase) addPlace(extended, read.listed ? 0.9 : 0.8, "rules:phrase");
      else if (preposition) addPlace(extended, 0.85, "rules:preposition");
      else if (weak && !read.ambiguous) addPlace(extended, 0.8, "rules:preposition");
      else if (extended !== read && extended.end > read.end && !read.ambiguous) addPlace(extended, 0.85, "rules:region");
      else if (!read.ambiguous) addPlace(read, 0.6, "rules:list");
      i = read.next - 1;
    }
  }

  // Street addresses -------------------------------------------------------------------------------------------

  if (want.has("street_address")) {
    /** True when an address label (`Address:`) comes just before token `index` on its line. */
    const labelled = (index: number): boolean => isPunct(index - 1, ":") && phraseEndsAt(index - 2, ADDRESS_LABEL_SET);

    /** Skips `,` and one line break; returns the next token index. */
    const skipSeparator = (from: number): number => {
      let k = from;
      if (isPunct(k, ",")) k += 1;
      if (t(k)?.kind === "nl") k += 1;
      return k;
    };

    /** A region and postcode at `at` (`IL 62704`, `ON K1A 0B1`, `NSW 2000`, `SW1A 2AA`): the end offset, or -1. */
    const regionPostcode = (at: number): { end: number; country: string } | null => {
      let k = at;
      if (isPunct(k, ",")) k += 1;
      const token = t(k);
      if (!token) return null;
      const sticky = (pattern: RegExp, index: number) => {
        const target = t(index);
        if (!target) return -1;
        pattern.lastIndex = target.start;
        return pattern.exec(text) ? pattern.lastIndex : -1;
      };
      // US: a state code or name, then a ZIP code.
      let stateEnd = -1;
      if (token.kind === "w" && US_STATES[token.text] !== undefined) stateEnd = k + 1;
      else {
        for (let n = US_STATE_NAME_MAX_WORDS; n >= 1 && stateEnd < 0; n -= 1) {
          const phrase = wordsEndingAt(k + n - 1, n);
          if (phrase && US_STATE_NAMES.has(phrase) && UPPER.test(token.text)) stateEnd = k + n;
        }
      }
      if (stateEnd >= 0) {
        const zip = t(stateEnd);
        if (zip?.kind === "n" && /^\d{5}$/.test(zip.text)) {
          if (isPunct(stateEnd + 1, "-") && touching(stateEnd, stateEnd + 1) && /^\d{4}$/.test(t(stateEnd + 2)?.text ?? "") && touching(stateEnd + 1, stateEnd + 2)) {
            return { end: t(stateEnd + 2)!.end, country: "us" };
          }
          return { end: zip.end, country: "us" };
        }
      }
      if (token.kind === "w" && CA_PROVINCES.has(token.text)) {
        const end = sticky(CA_POSTCODE_PATTERN, k + 1);
        if (end >= 0) return { end, country: "ca" };
      }
      if (token.kind === "w" && AU_STATES.has(token.text)) {
        const code = t(k + 1);
        if (code?.kind === "n" && /^\d{4}$/.test(code.text)) return { end: code.end, country: "au" };
      }
      const uk = sticky(UK_POSTCODE_PATTERN, k);
      if (uk >= 0) return { end: uk, country: "uk" };
      return null;
    };

    /** A locality after a street line: up to four town words, then a region and postcode. */
    const englishLocality = (from: number): { end: number; country: string } | null => {
      const start = skipSeparator(from);
      let k = start;
      for (let words = 0; words <= 4; words += 1) {
        const found = regionPostcode(k);
        // A UK postcode may follow the street line directly; every other format needs a town first.
        if (found && (words > 0 || found.country === "uk")) return found;
        if (isPunct(k, ",")) k += 1;
        const token = t(k);
        if (!token || token.kind !== "w" || !UPPER.test(token.text)) return null;
        k += 1;
      }
      return null;
    };

    /** A German or French locality: a five-digit postcode and a town. */
    const fiveDigitLocality = (from: number): number => {
      const k = skipSeparator(from);
      const code = t(k);
      if (code?.kind !== "n" || !/^\d{5}$/.test(code.text)) return -1;
      let j = k + 1;
      while (j < k + 4 && t(j)?.kind === "w" && UPPER.test(t(j)!.text)) j += 1;
      return j > k + 1 ? t(j - 1)!.end : -1;
    };

    const addAddress = (start: number, end: number, score: number, source: string) => {
      spans.push({ start, end, dataClass: "street_address", score, source });
    };

    /** An optional unit after a street line (`, Apt 4B`, `Suite 200`, `#12`): the next token index. */
    const skipUnit = (from: number): number => {
      let k = from;
      if (isPunct(k, ",")) k += 1;
      const token = t(k);
      if (token?.kind === "w" && UNIT_WORDS.has(token.text)) {
        let j = k + 1;
        if (isPunct(j, ".") && touching(k, j)) j += 1;
        if (isPunct(j, "#")) j += 1;
        const value = t(j);
        if (value && (value.kind === "n" || (value.kind === "w" && value.text.length <= 3))) return j + 1;
        return from;
      }
      if (isPunct(k, "#") && t(k + 1)?.kind === "n") return k + 2;
      return from;
    };

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;

      // English order: `221B Baker Street`, `1600 Pennsylvania Avenue NW`, `350 5th Ave`.
      if (token.kind === "n" && HOUSE_NUMBER.test(token.text) && !(t(i - 1) && touching(i - 1, i) && t(i - 1)!.kind !== "nl")) {
        let j = i + 1;
        if (t(j)?.kind === "w" && DIRECTIONS.has(t(j)!.text)) {
          j += 1;
          if (isPunct(j, ".") && touching(j - 1, j)) j += 1;
        }
        let nameWords = 0;
        let streetEnd = -1;
        let streetNext = -1;
        for (let steps = 0; steps < 6; steps += 1) {
          const word = t(j);
          if (!word) break;
          const isOrdinal = word.kind === "n" && ORDINAL.test(word.text);
          if (!(isOrdinal || (word.kind === "w" && UPPER.test(word.text)))) break;
          if (word.kind === "w" && STREET_TYPES.has(word.text) && nameWords >= 1) {
            streetEnd = word.end;
            streetNext = j + 1;
            // The dot of an abbreviation (`St.`, `Ave.`) belongs to it; after a full word it ends the sentence.
            if (word.text.length <= 4 && isPunct(j + 1, ".") && touching(j, j + 1)) {
              streetEnd = t(j + 1)!.end;
              streetNext = j + 2;
            }
          }
          nameWords += 1;
          j += 1;
        }
        if (streetEnd >= 0) {
          let next = streetNext;
          const direction = t(next);
          if (direction?.kind === "w" && DIRECTIONS.has(direction.text) && direction.text.length <= 2) {
            streetEnd = direction.end;
            next += 1;
          }
          const afterUnit = skipUnit(next);
          if (afterUnit !== next) {
            streetEnd = t(afterUnit - 1)!.end;
            next = afterUnit;
          }
          const locality = englishLocality(next);
          if (locality) addAddress(token.start, locality.end, 0.95, `rules:${locality.country}`);
          else addAddress(token.start, streetEnd, labelled(i) ? 0.85 : 0.75, "rules:street");
          continue;
        }
      }

      // P.O. boxes: `PO Box 123`, `P.O. Box 77`.
      if (token.kind === "w" && token.text === "Box" && t(i + 1)?.kind === "n") {
        let start = -1;
        if (t(i - 1)?.text === "PO" || t(i - 1)?.text === "POB") start = t(i - 1)!.start;
        else if (isPunct(i - 1, ".") && t(i - 2)?.text === "O" && isPunct(i - 3, ".") && t(i - 4)?.text === "P") start = t(i - 4)!.start;
        if (start >= 0) {
          const locality = englishLocality(i + 2);
          addAddress(start, locality ? locality.end : t(i + 1)!.end, locality ? 0.95 : labelled(i) ? 0.85 : 0.75, "rules:po-box");
          continue;
        }
      }

      // German order: `Hauptstraße 5`, `Berliner Straße 12a`, `Hauptstr. 7`, then `10115 Berlin`.
      if (token.kind === "w" && UPPER.test(token.text)) {
        const lower = token.lower;
        const suffix = DE_STREET_SUFFIXES.find((candidate) => lower.endsWith(candidate));
        const compound = suffix !== undefined && lower.length > suffix.length + 2;
        const separate = ["straße", "strasse", "str", "weg", "platz", "allee", "gasse"].includes(lower) && t(i - 1)?.kind === "w" && UPPER.test(t(i - 1)!.text);
        if (compound || separate) {
          let j = i + 1;
          if (isPunct(j, ".") && touching(i, j)) j += 1;
          else if (suffix === "str" || lower === "str") j = -1;
          const number = j >= 0 ? t(j) : undefined;
          if (number?.kind === "n" && DE_HOUSE_NUMBER.test(number.text)) {
            const start = separate ? t(i - 1)!.start : token.start;
            const localityEnd = fiveDigitLocality(j + 1);
            if (localityEnd >= 0) addAddress(start, localityEnd, 0.95, "rules:de");
            else addAddress(start, number.end, labelled(separate ? i - 1 : i) ? 0.85 : 0.75, "rules:de-street");
            continue;
          }
        }
      }

      // French order: `12 rue de la Paix`, `5 bis, avenue Victor Hugo`, then `75002 Paris`.
      if (token.kind === "n" && /^\d{1,4}$/.test(token.text)) {
        let j = i + 1;
        if (t(j)?.kind === "w" && ["bis", "ter", "b"].includes(t(j)!.lower)) j += 1;
        if (isPunct(j, ",")) j += 1;
        if (t(j)?.kind === "w" && FR_STREET_TYPES.has(t(j)!.lower)) {
          let k = j + 1;
          let capitals = 0;
          let end = -1;
          while (k < j + 7 && t(k)?.kind === "w") {
            const word = t(k)!;
            if (UPPER.test(word.text) || /^[dl]['’]\p{Lu}/u.test(word.text)) {
              capitals += 1;
              end = word.end;
            } else if (!FR_PARTICLES.has(word.lower)) break;
            k += 1;
          }
          if (capitals > 0) {
            const localityEnd = fiveDigitLocality(k);
            if (localityEnd >= 0) addAddress(token.start, localityEnd, 0.95, "rules:fr");
            else addAddress(token.start, end, labelled(i) ? 0.85 : 0.75, "rules:fr-street");
            continue;
          }
        }
      }
    }
  }

  return resolveOverlaps(spans.filter((span) => want.has(span.dataClass)));
}

/** Overlapping spans: the higher score wins, then the longer span, then the earlier one. O(n log n) searches. */
export function resolveOverlaps<T extends { start: number; end: number; score: number }>(spans: readonly T[]): T[] {
  const ordered = [...spans].filter((span) => span.end > span.start).sort((a, b) => b.score - a.score || b.end - b.start - (a.end - a.start) || a.start - b.start);
  // Kept spans are disjoint, so sorted by start they are sorted by end too.
  const kept: T[] = [];
  for (const span of ordered) {
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (kept[mid]!.end <= span.start) lo = mid + 1;
      else hi = mid;
    }
    // `lo` is the first kept span ending after this one starts: it overlaps when it also starts before this one ends.
    if (lo < kept.length && kept[lo]!.start < span.end) continue;
    kept.splice(lo, 0, span);
  }
  return kept;
}
