import { nanoid } from "nanoid";
import type { VariableRecord } from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";

const VALID_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE_LENGTH = 65536;

export class VariablesService {
  constructor(private readonly store: Store) {}

  async list(projectId?: string): Promise<VariableRecord[]> {
    return await this.store.listVariables(projectId);
  }

  async get(id: string): Promise<VariableRecord | null> {
    return await this.store.getVariable(id);
  }

  async create(input: { projectId: string; key: string; value: string; createdBy?: string | null }): Promise<VariableRecord> {
    this.validateKey(input.key);
    this.validateValue(input.value);
    const existing = await this.store.findVariableByKey(input.projectId, input.key);
    if (existing) {
      throw new Error(`Variable '${input.key}' already exists in this project`);
    }
    const id = `var_${nanoid(14)}`;
    await this.store.upsertVariable({
      id,
      projectId: input.projectId,
      key: input.key,
      value: input.value,
      createdBy: input.createdBy ?? null
    });
    const record = await this.store.getVariable(id);
    if (!record) throw new Error("failed to create variable");
    return record;
  }

  async update(id: string, patch: { key?: string; value?: string }): Promise<VariableRecord | null> {
    const existing = await this.store.getVariable(id);
    if (!existing) return null;
    const nextKey = patch.key ?? existing.key;
    if (patch.key !== undefined) this.validateKey(nextKey);
    if (patch.value !== undefined) this.validateValue(patch.value);
    if (patch.key !== undefined && patch.key !== existing.key) {
      const collision = await this.store.findVariableByKey(existing.projectId, patch.key);
      if (collision && collision.id !== id) {
        throw new Error(`Variable '${patch.key}' already exists in this project`);
      }
    }
    await this.store.upsertVariable({
      id,
      projectId: existing.projectId,
      key: nextKey,
      value: patch.value ?? existing.value,
      createdBy: existing.createdBy
    });
    return await this.store.getVariable(id);
  }

  async delete(id: string): Promise<boolean> {
    return await this.store.deleteVariable(id);
  }

  /**
   * Returns a plain `{ KEY: value }` map for use as workflow-time variables.
   * Project-level variables are the baseline; workflow.variables override.
   */
  async resolveForProject(projectId: string): Promise<Record<string, string>> {
    const rows = await this.store.listVariables(projectId);
    const map: Record<string, string> = {};
    for (const row of rows) map[row.key] = row.value;
    return map;
  }

  private validateKey(key: string): void {
    if (!key || !VALID_KEY_RE.test(key)) {
      throw new Error("Variable key must match /^[A-Za-z_][A-Za-z0-9_]*$/");
    }
    if (key.length > 120) throw new Error("Variable key too long (max 120)");
  }

  private validateValue(value: string): void {
    if (typeof value !== "string") throw new Error("Variable value must be a string");
    if (value.length > MAX_VALUE_LENGTH) {
      throw new Error(`Variable value too long (max ${MAX_VALUE_LENGTH})`);
    }
  }
}
