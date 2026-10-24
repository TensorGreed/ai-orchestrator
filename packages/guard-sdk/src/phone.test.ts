import { describe, expect, it } from "vitest";
import { callingCodeOf, parsePhone, phoneMaskCandidates, phoneMaskKeys, samePhone } from "./phone";

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
