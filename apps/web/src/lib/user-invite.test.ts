import { describe, expect, it } from "vitest";
import { inviteTokenFromSearch, stripInviteParam } from "./user-invite";

describe("invite links (roadmap 7.3)", () => {
  it("reads the token from the address", () => {
    expect(inviteTokenFromSearch("?invite=abc")).toBe("abc");
    expect(inviteTokenFromSearch("?x=1&invite=a-b_c")).toBe("a-b_c");
    expect(inviteTokenFromSearch("?invite=")).toBeNull();
    expect(inviteTokenFromSearch("")).toBeNull();
  });

  it("drops only the invite parameter", () => {
    expect(stripInviteParam("/", "?invite=abc", "")).toBe("/");
    expect(stripInviteParam("/studio", "?workflow=w1&invite=abc", "#top")).toBe("/studio?workflow=w1#top");
    expect(stripInviteParam("/", "?workflow=w1", "")).toBeNull();
  });
});
