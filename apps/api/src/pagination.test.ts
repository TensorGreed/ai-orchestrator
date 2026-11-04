import { describe, expect, it } from "vitest";
import { PAGE_SIZE_MAX, PaginationQueryError, pageOf, pageOfById, pageRequestFromQuery, withIdTiebreak } from "./pagination.js";

describe("pageRequestFromQuery", () => {
  it("is null without page or pageSize, so a route answers as before", () => {
    expect(pageRequestFromQuery(undefined)).toBeNull();
    expect(pageRequestFromQuery({})).toBeNull();
    expect(pageRequestFromQuery({ page: "", pageSize: "  " })).toBeNull();
    expect(pageRequestFromQuery({ limit: "5", projectId: "p" })).toBeNull();
  });

  it("defaults page to 1 and pageSize to 20", () => {
    expect(pageRequestFromQuery({ page: "3" })).toEqual({ page: 3, pageSize: 20, offset: 40 });
    expect(pageRequestFromQuery({ pageSize: "5" })).toEqual({ page: 1, pageSize: 5, offset: 0 });
  });

  it("caps pageSize at the hard maximum", () => {
    expect(pageRequestFromQuery({ page: "2", pageSize: "1000" })).toEqual({ page: 2, pageSize: PAGE_SIZE_MAX, offset: PAGE_SIZE_MAX });
  });

  it("refuses values that are not positive integers", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "1e3", "99999999999999999999"]) {
      expect(() => pageRequestFromQuery({ page: bad })).toThrow(PaginationQueryError);
      expect(() => pageRequestFromQuery({ pageSize: bad })).toThrow(PaginationQueryError);
    }
  });

  it("takes the last of repeated values", () => {
    expect(pageRequestFromQuery({ page: ["1", "2"], pageSize: "2" })).toEqual({ page: 2, pageSize: 2, offset: 2 });
  });
});

describe("pageOf", () => {
  it("slices one page and counts the whole list", () => {
    const request = pageRequestFromQuery({ page: "2", pageSize: "2" })!;
    expect(pageOf(["a", "b", "c", "d", "e"], request)).toEqual({ items: ["c", "d"], total: 5, page: 2, pageSize: 2 });
    expect(pageOf(["a"], request)).toEqual({ items: [], total: 1, page: 2, pageSize: 2 });
  });
});

describe("withIdTiebreak", () => {
  it("orders equal keys by id and keeps the list's own order otherwise", () => {
    const items = [
      { id: "z", name: "b" },
      { id: "c", name: "a" },
      { id: "a", name: "a" },
      { id: "b", name: "c" },
      { id: "y", name: "b" }
    ];
    expect(withIdTiebreak(items, (item) => item.name).map((item) => item.id)).toEqual(["z", "a", "c", "b", "y"]);
  });

  it("pages over the tiebroken order", () => {
    const items = [{ id: "2", k: 1 }, { id: "1", k: 1 }, { id: "3", k: 2 }];
    expect(pageOfById(items, { page: 1, pageSize: 1, offset: 0 }, (item) => item.k).items).toEqual([{ id: "1", k: 1 }]);
  });
});
