/**
 * v77 — store contract: a content rules toolset member's options (document scanning), on both stores.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import { testSql } from "../../test-support/test-sql.js";

describeStoreContract("store contract: content rules member options", (ctx) => {
  it("keeps the documents options of a content rules member, and reads a member without them as off", async () => {
    const store = ctx.store();
    const documents = { enabled: true, allowUrls: true, allowedHosts: ["docs.example.com", "*.example.org"] };
    const toolset = await store.createMcpToolset({
      id: "mts_docs",
      slug: "docs",
      name: "Docs",
      description: null,
      projectId: null,
      enabled: true,
      trackSessionLabels: false,
      rateLimit: null,
      members: [{ kind: "content_rules", ruleSetId: "pii", documents }],
      createdBy: null
    });
    expect((await store.getMcpToolset(toolset.id))?.members).toEqual([expect.objectContaining({ kind: "content_rules", ruleSetId: "pii", documents })]);

    // Turning them off (no options) clears the stored column; an unreadable value reads as off.
    await store.updateMcpToolset(toolset.id, { members: [{ kind: "content_rules", ruleSetId: null }] });
    const [member] = (await store.getMcpToolset(toolset.id))!.members;
    expect(member).toEqual({ id: expect.any(String), kind: "content_rules", ruleSetId: null });
    await testSql(store).run("UPDATE mcp_toolset_members SET options_json = ? WHERE toolset_id = ?", '{"documents":{"enabled":"yes"}}', toolset.id);
    expect((await store.getMcpToolset(toolset.id))!.members[0]).not.toHaveProperty("documents");
  });
});
