import { describe, expect, it } from "vitest";
import { parseAssistantResponse } from "../src/responseParser";

describe("parseAssistantResponse", () => {
  it("extracts message, code blocks, attachments, actions, and context updates", () => {
    const parsed = parseAssistantResponse({
      output: {
        message: "Use the proposed patch.",
        python_code: "print('ready')",
        attachments: [
          {
            filename: "report.html",
            mimeType: "text/html",
            downloadUrl: "data:text/html;base64,PGgxPk9LPC9oMT4="
          }
        ],
        actions: [
          {
            id: "a1",
            type: "patch",
            title: "Update greeting",
            file: "src/app.ts",
            diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new"
          }
        ],
        context_update: "User prefers patch actions."
      }
    });

    expect(parsed.text).toBe("Use the proposed patch.");
    expect(parsed.codes).toEqual([{ language: "python", source: "print('ready')" }]);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]).toMatchObject({
      id: "a1",
      type: "patch",
      title: "Update greeting",
      file: "src/app.ts",
      status: "pending"
    });
    expect(parsed.contextUpdate).toBe("User prefers patch actions.");
  });

  it("accepts command arrays and top-level patch fields from loose workflow shapes", () => {
    const parsed = parseAssistantResponse({
      result: JSON.stringify({
        message: "Review the actions.",
        commands: [{ title: "Run tests", command: "pnpm test" }],
        patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new",
        file: "README.md"
      })
    });

    expect(parsed.actions).toHaveLength(2);
    expect(parsed.actions.map((action) => action.type).sort()).toEqual(["command", "patch"]);
    expect(parsed.actions.find((action) => action.type === "command")).toMatchObject({
      title: "Run tests",
      command: "pnpm test",
      requiresApproval: true
    });
    expect(parsed.actions.find((action) => action.type === "patch")).toMatchObject({
      file: "README.md"
    });
  });

  it("keeps helper-chat final_html and python_code separate", () => {
    const parsed = parseAssistantResponse({
      answer: {
        final_html: "<html><body>Report</body></html>",
        python_code: "import requests\nprint('report')"
      }
    });

    expect(parsed.text).toBe("<html><body>Report</body></html>");
    expect(parsed.codes).toEqual([
      {
        language: "python",
        source: "import requests\nprint('report')"
      }
    ]);
  });
});
