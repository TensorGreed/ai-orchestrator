import { nanoid } from "nanoid";
import type { VariableRecord } from "@ai-orchestrator/shared";
import type { SqliteStore } from "../db/database";

const VALID_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE_LENGTH = 65536;

export class VariablesService {
  constructor(private readonly store: SqliteStore) {}

  list(projectId?: string): VariableRecord[] {
    return this.store.listVariables(projectId);
  }

  get(id: string): VariableRecord | null {
    return this.store.getVariable(id);
  }

  create(input: { projectId: string; key: string; value: string; createdBy?: string | null }): VariableRecord {
    this.validateKey(input.key);
    this.validateValue(input.value);
    const existing = this.store.findVariableByKey(input.projectId, input.key);
    if (existing) {
      throw new Error(`Variable '${input.key}' already exists in this project`);
    }
    const id = `var_${nanoid(14)}`;
    this.store.upsertVariable({
      id,
      projectId: input.projectId,
      key: input.key,
      value: input.value,
      createdBy: input.createdBy ?? null
    });
    const record = this.store.getVariable(id);
    if (!record) throw new Error("failed to create variable");
    return record;
  }

  update(id: string, patch: { key?: string; value?: string }): VariableRecord | null {
    const existing = this.store.getVariable(id);
    if (!existing) return null;
    const nextKey = patch.key ?? existing.key;
    if (patch.key !== undefined) this.validateKey(nextKey);
    if (patch.value !== undefined) this.validateValue(patch.value);
    if (patch.key !== undefined && patch.key !== existing.key) {
      const collision = this.store.findVariableByKey(existing.projectId, patch.key);
      if (collision && collision.id !== id) {
        throw new Error(`Variable '${patch.key}' already exists in this project`);
      }
    }
    this.store.upsertVariable({
      id,
      projectId: existing.projectId,
      key: nextKey,
      value: patch.value ?? existing.value,
      createdBy: existing.createdBy
    });
    return this.store.getVariable(id);
  }

  delete(id: string): boolean {
    return this.store.deleteVariable(id);
  }

  /**
   * Returns a plain `{ KEY: value }` map for use as workflow-time variables.
   * Project-level variables are the baseline; workflow.variables override.
   */
  resolveForProject(projectId: string): Record<string, string> {
    const rows = this.store.listVariables(projectId);
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
