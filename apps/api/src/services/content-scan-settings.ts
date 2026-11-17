/**
 * A rule set's data scan settings for the content rules tools and document scans. Stored `data.entities` options that
 * do not parse (only a hand-edited stored row can hold them: saving validates them) are ignored, and the check runs
 * with its default options for the classes they list; the server log gets one warning per rule set version.
 */

import { sensitiveScanSettingsOf, type GuardProfile, type SensitiveScanSettings } from "@ai-orchestrator/guard-sdk";

export type ContentScanSettingsWarn = (message: string, metadata: { ruleSetId: string; version: number }) => void;

/** How many rule set versions are remembered as warned (older ones may warn again). */
const WARNED_LIMIT = 1_000;

export class ContentScanSettings {
  private readonly warned = new Set<string>();

  constructor(private readonly warn: ContentScanSettingsWarn = () => undefined) {}

  settingsOf(ruleSet: { id: string; version: number; profile: GuardProfile } | null): SensitiveScanSettings {
    const settings = sensitiveScanSettingsOf(ruleSet?.profile ?? null);
    if (ruleSet && settings.entitiesOptionsInvalid) {
      const key = `${ruleSet.id}\u0000${ruleSet.version}`;
      if (!this.warned.has(key)) {
        if (this.warned.size >= WARNED_LIMIT) this.warned.delete(this.warned.values().next().value!);
        this.warned.add(key);
        this.warn("A rule set's stored names and addresses options are invalid; the check's defaults are used. Save the rule set again to fix them.", {
          ruleSetId: ruleSet.id,
          version: ruleSet.version
        });
      }
    }
    return settings;
  }
}
