import { breakGlassLinkFromHash, stripBreakGlassFragment } from "./break-glass";

describe("break-glass links (13.2)", () => {
  it("reads the token and the admin from the fragment", () => {
    expect(breakGlassLinkFromHash("#break_glass=bg_abc&email=root%40example.com")).toEqual({ token: "bg_abc", email: "root@example.com" });
    expect(breakGlassLinkFromHash("#break_glass=bg_abc")).toEqual({ token: "bg_abc", email: null });
    expect(breakGlassLinkFromHash("#invite=x")).toBeNull();
    expect(breakGlassLinkFromHash("")).toBeNull();
  });

  it("drops the token from the address and keeps the rest", () => {
    expect(stripBreakGlassFragment("/", "", "#break_glass=bg_abc&email=a%40b")).toBe("/");
    expect(stripBreakGlassFragment("/app/", "?x=1", "#break_glass=bg_abc&other=2")).toBe("/app/?x=1#other=2");
    expect(stripBreakGlassFragment("/", "", "#other=2")).toBeNull();
  });
});
