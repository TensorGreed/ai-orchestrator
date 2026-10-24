import { describe, expect, it } from "vitest";
import { scanDlp } from "./detectors/dlp";
import { callingCodeOf, comparePhones, parsePhone, phoneInCountry, phoneMaskCandidates, phoneMaskKeys, samePhone, scanInternationalPhones, trunkPrefixesFor } from "./phone";

const same = (a: string, b: string, bExplicit = false) => samePhone(parsePhone(a)!, parsePhone(b, bExplicit)!);

describe("parsePhone", () => {
  it("reads the country code (prefix-free), a trunk 0 and the national number", () => {
    expect(parsePhone("+44 (0)20 7946 0958")).toMatchObject({ explicit: true, cc: "44", national: "2079460958" });
    expect(parsePhone("0044 20 7946 0958")).toMatchObject({ explicit: true, cc: "44", national: "2079460958" });
    expect(parsePhone("+1 (415) 555-1234")).toMatchObject({ cc: "1", national: "4155551234" });
    expect(parsePhone("+47 2212 3456")).toMatchObject({ cc: "47", national: "22123456" });
    expect(parsePhone("020 7946 0958")).toMatchObject({ explicit: false, cc: null, national: "2079460958" });
    expect(parsePhone("4155551234")).toMatchObject({ explicit: false, national: "4155551234" });
    expect(callingCodeOf("3531234")).toBe("353");
    expect(callingCodeOf("999")).toBeNull();
  });
});

describe("samePhone (the lookup: never over-matches)", () => {
  it("the same number in E.164, national, dashed and trunk forms matches", () => {
    for (const other of ["(207) 946-0958", "207-946-0958", "+1 207 946 0958", "12079460958", "2079460958"]) expect(same("+1 (207) 946-0958", other), other).toBe(true);
    for (const other of ["020 7946 0958", "+44 20 7946 0958", "442079460958", "0044 20 7946 0958"]) expect(same("+44 20 7946 0958", other), other).toBe(true);
  });

  it("a shared suffix or another country code never matches (reviewer probes)", () => {
    expect(same("+1 (207) 946-0958", "+44 20 7946 0958")).toBe(false);
    expect(same("+1 415-555-1234", "2024155551234")).toBe(false);
    expect(same("+1 415-555-1234", "4000004155551234")).toBe(false);
    expect(same("+1 912-345-6788", "123456788")).toBe(false);
    expect(same("+1 312 345 6788", "+1 412 345 6788")).toBe(false);
    expect(same("+1 415-555-1234", "+14155551234")).toBe(true);
    // A `+` the text puts before the run counts.
    expect(same("+1 415-555-1234", "44 4155551234", true)).toBe(false);
  });
});

describe("phone masking keys (masking: may over-mask)", () => {
  it("covers the international, national and trunk forms, and keeps the country code", () => {
    const keys = new Map(phoneMaskKeys(parsePhone("+47 2212 3456")!).map((entry) => [entry.key, entry.national]));
    for (const key of ["22123456", "022123456", "4722123456", "47022123456"]) expect(keys.get(key), key).toBe("22123456");
    // A run written with an international prefix is read down to the national number.
    expect(phoneMaskCandidates("004722123456")).toContain("22123456");
  });

  it("a number written without a country code keeps its own reading first", () => {
    const keys = phoneMaskKeys(parsePhone("4155551234")!);
    const asWritten = keys.find((entry) => entry.key === "4155551234")!;
    expect(asWritten.national).toBe("4155551234");
    expect(asWritten.strength).toBe(1);
  });
});

const certainty = (a: string, b: string, bExplicit = false) => comparePhones(parsePhone(a)!, parsePhone(b, bExplicit)!);

describe("comparePhones (round 3: exact or national_only, never a guessed country code)", () => {
  it("exact only when both carry the same country code and national number", () => {
    for (const other of ["+14155551234", "+1 (415) 555-1234", "0014155551234", "+1-415-555-1234"]) expect(certainty("+1 415-555-1234", other), other).toBe("exact");
    expect(certainty("+44 20 7946 0958", "+44 (0) 20 7946 0958")).toBe("exact");
    expect(certainty("+1 415-555-1234", "+33 415 555 1234")).toBeNull();
  });

  it("a number without a country code on either side is national_only", () => {
    for (const other of ["4155551234", "(415) 555-1234", "14155551234", "1-415-555-1234"]) expect(certainty("+1 415-555-1234", other), other).toBe("national_only");
    expect(certainty("415-555-1234", "4155551234")).toBe("national_only");
  });

  it("re-review 2 A1 rows: national_only or no match, never exact", () => {
    const rows: Array<[string, string, "national_only" | null]> = [
      ["+44 20 7946 0958", "(207) 946-0958", "national_only"],
      ["+1 (207) 946-0958", "020 7946 0958", "national_only"],
      ["(415) 555-1234", "+33 415 555 1234", "national_only"],
      ["(415) 555-1234", "+49 415 555 1234", "national_only"],
      ["(207) 946-0958", "44 207 946 0958", null],
      ["020 7946 0958", "(207) 946-0958", "national_only"],
      ["020 7946 0958", "+1 207 946 0958", "national_only"],
      ["415-555-1234", "7 415 555 1234", null],
      ["415-555-1234", "86 415 555 1234", null]
    ];
    for (const [query, stored, expected] of rows) expect(certainty(query, stored), `${query} vs ${stored}`).toBe(expected);
  });

  it("A4 trunk table: Hungary 06, Russia 8, Italy keeps its 0", () => {
    expect(trunkPrefixesFor("44")).toEqual(["0"]);
    expect(trunkPrefixesFor("36")).toEqual(["06"]);
    expect(trunkPrefixesFor("7")).toEqual(["8"]);
    expect(trunkPrefixesFor("39")).toEqual([]);
    expect(certainty("+36 1 234 5678", "06 1 234 5678")).toBe("national_only");
    expect(certainty("+7 495 123 4567", "8 (495) 123-45-67")).toBe("national_only");
    expect(certainty("+375 17 123 4567", "8 17 123 4567")).toBe("national_only");
    expect(parsePhone("+39 06 1234 5678")).toMatchObject({ cc: "39", national: "0612345678" });
    expect(certainty("+39 06 1234 5678", "06 1234 5678")).toBe("national_only");
    expect(certainty("+39 06 1234 5678", "+39 0612345678")).toBe("exact");
    // Hungary's national form is not read with a single 0 dropped, and an 8 is no trunk for the UK.
    expect(certainty("+36 1 234 5678", "0612345678".slice(1))).toBeNull();
    expect(certainty("+44 20 7946 0958", "8 20 7946 0958")).toBeNull();
  });

  it("a country chosen in the lookup makes a plain number explicit", () => {
    expect(phoneInCountry("4155551234", "1")).toMatchObject({ explicit: true, cc: "1", national: "4155551234" });
    expect(phoneInCountry("020 7946 0958", "44")).toMatchObject({ cc: "44", national: "2079460958" });
    expect(phoneInCountry("06 1 234 5678", "36")).toMatchObject({ cc: "36", national: "12345678" });
    expect(phoneInCountry("+44 20 7946 0958", "1")).toBeNull();
    expect(phoneInCountry("4155551234", "999")).toBeNull();
  });
});

describe("scanInternationalPhones (capture only)", () => {
  const found = (text: string) => scanInternationalPhones(text).map((span) => text.slice(span.start, span.end));

  it("re-review 2 A2 forms are found whole", () => {
    for (const written of [
      "+14155551234",
      "+447700900123",
      "+33 1 23 45 67 89",
      "+44 (0) 20 7946 0958",
      "+61 2 9876 5432",
      "+91 98765 43210",
      "+81 3-1234-5678",
      "+353 1 234 5678",
      "+36 1 234 5678",
      "+7 495 123-45-67",
      "0044 20 7946 0958",
      "+39 06 1234 5678"
    ]) {
      expect(found(`call ${written} today`), written).toEqual([written]);
      expect(found(`{"phone":"${written}"}`), written).toEqual([written]);
    }
  });

  it("leaves other numbers alone", () => {
    for (const text of ["+999 1234 5678", "+1 234", "+1000000.00", "id_+14155551234x", "a+14155551234", "2024-10-24T00:00:00Z", "+12345678901234567890"]) expect(found(text), text).toEqual([]);
  });

  it("does not change the runtime guard's DLP phone pattern", () => {
    expect(scanDlp("+14155551234").some((match) => match.dataClass === "phone")).toBe(false);
    expect(scanDlp("+33 1 23 45 67 89").some((match) => match.dataClass === "phone")).toBe(false);
  });
});
