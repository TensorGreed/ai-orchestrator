import { describe, expect, it } from "vitest";
import { inviteTokenFromLocation, stripInviteParam } from "./user-invite";

describe("invite links (roadmap 7.3)", () => {
  it("reads the token from the fragment, with the query as a fallback", () => {
    expect(inviteTokenFromLocation("", "#invite=abc")).toBe("abc");
    expect(inviteTokenFromLocation("?x=1", "#invite=a-b_c")).toBe("a-b_c");
    expect(inviteTokenFromLocation("?invite=old", "")).toBe("old");
    expect(inviteTokenFromLocation("?invite=old", "#invite=new")).toBe("new");
    expect(inviteTokenFromLocation("?invite=", "#invite=")).toBeNull();
    expect(inviteTokenFromLocation("", "")).toBeNull();
  });

  it("drops only the invite parameter", () => {
    expect(stripInviteParam("/", "", "#invite=abc")).toBe("/");
    expect(stripInviteParam("/", "?invite=abc", "")).toBe("/");
    expect(stripInviteParam("/studio", "?workflow=w1&invite=abc", "#top=1")).toBe("/studio?workflow=w1#top=1");
    expect(stripInviteParam("/", "?workflow=w1", "")).toBeNull();
  });
});
