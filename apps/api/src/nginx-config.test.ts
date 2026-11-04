/**
 * Every shipped nginx config that proxies to the API must overwrite X-Forwarded-For, or a client-written value
 * passes through and TRUST_PROXY would take it as the client address.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const configs = ["ops/nginx/ai-orchestrator.conf", "apps/web/nginx.conf", "ops/loadtest/nginx.conf"];

function block(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && (depth -= 1) === 0) return text.slice(open + 1, index);
  }
  return text.slice(open + 1);
}

function forwarded(_text: string): RegExp {
  return /proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for\s*;/i;
}

describe("shipped nginx configs", () => {
  for (const file of configs) {
    it(`${file} sets X-Forwarded-For in every proxy_pass location`, () => {
      const text = fs.readFileSync(path.join(root, file), "utf8").replace(/#.*$/gm, "");
      const servers = [...text.matchAll(/\bserver\s*\{/g)].map((match) => block(text, match.index! + match[0].length - 1));
      expect(servers.length).toBeGreaterThan(0);
      let proxied = 0;
      for (const server of servers) {
        const locations = [...server.matchAll(/\blocation\s+[^{]*\{/g)];
        const bodies = locations.map((match) => block(server, match.index! + match[0].length - 1));
        let outside = server;
        for (const body of bodies) outside = outside.replace(body, "");
        const inherited = forwarded(outside).test(outside);
        for (const body of bodies) {
          if (!/\bproxy_pass\b/.test(body)) continue;
          proxied += 1;
          const own = /proxy_set_header/.test(body);
          expect(own ? forwarded(body).test(body) : inherited, body.trim().slice(0, 60)).toBe(true);
        }
      }
      expect(proxied).toBeGreaterThan(0);
    });
  }
});
