import { describe, expect, it, vi } from "vitest";

const constructed: Array<{ url: string; opts: unknown }> = [];

vi.mock("ioredis", () => ({
  default: class FakeRedis {
    constructor(url: string, opts?: unknown) {
      constructed.push({ url, opts });
    }
    async call(...args: unknown[]) {
      return args;
    }
    async quit() {
      return "OK";
    }
  }
}));

import { executeRedisCommand } from "./tier1";

describe("redis_command client options", () => {
  it("pins the RESP2 wire protocol so replies keep the shape they had on ioredis 5", async () => {
    const res = (await executeRedisCommand(
      { url: "redis://example:6379", command: "get", args: ["k"] },
      { templateData: {}, resolveSecret: async () => "" }
    )) as { command: string; result: unknown };
    expect(res.command).toBe("GET");
    expect(constructed).toEqual([{ url: "redis://example:6379", opts: { protocol: 2 } }]);
  });
});
