/**
 * Content rules as MCP gateway tools: detect, redact and restore sensitive data for a gateway client, on a toolset
 * an admin gave the `content_rules` member (nothing changes for toolsets without it).
 *
 * - Detection is the data scan with the rule set's dictionaries, allow-list and data detector options (the member's
 *   rule set, or one the call names that the toolset makes available), and a risk level per input.
 * - Redaction styles: `placeholder` and `token` are reversible (the map, or the vault tokens issued, are kept sealed
 *   in `content_redactions` under a `redaction_id`, bound to the client and the toolset's project scope, expiring);
 *   `mask` and `hash` (keyed per project scope) are one-way.
 * - Restore is denied unless a reveal rule names the calling client (`subjects.gatewayClients`). Rules come from the
 *   member's rule set and the call's gateway rule sets (an enforced project rule set with a `reveal` block is the only
 *   source, as in runs). A rule that asks for approval withholds its class: a gateway call cannot wait for a person.
 * - Every call records rule events with masked evidence or token hashes only, and a restore writes an audit entry
 *   (who, client, counts per class, withheld classes; never values) before anything is given back.
 */

import { createHash, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import {
  createTokenVaultProvider,
  DLP_DETECTOR_ID,
  highestRiskLevel,
  InMemoryPlaceholderBook,
  mapStrings,
  maskForDataClass,
  placeholdersIn,
  profileRevealRules,
  revealTokens,
  rewriteMatches,
  riskLevelOf,
  scanSensitiveTextAsync,
  EntityScanError,
  ENTITIES_DETECTOR_ID,
  type GuardEntityRecognizer,
  stringsIn,
  JsonTooDeepError,
  type DlpMatch,
  type RevealRule,
  type RiskLevel,
  type SensitiveScanSettings,
  type TokenVaultStorage
} from "@ai-orchestrator/guard-sdk";
import {
  CONTENT_TOOLS_MAX_CHARS,
  CONTENT_REDACTION_MIN_TTL_SECONDS,
  detectSensitiveDataArgsSchema,
  findRevealRule,
  GUARD_BUILTIN_PROFILE_ID,
  isEntityDataClass,
  REVEAL_EVENT_DETECTOR_ID,
  REVEAL_GATEWAY_CLIENT_SOURCE,
  redactSensitiveDataArgsSchema,
  restoreSensitiveDataArgsSchema,
  documentHostAllowed,
  SCAN_DOCUMENT_TOOL_NAME,
  scanDocumentArgsSchema,
  type ContentRulesDocumentsOptions,
  type ContentRulesGatewayToolName,
  type ContentToolFinding,
  type DocumentScanResult,
  type ContentToolInputResult,
  type RedactionStyle,
  type RevealClassSummary,
  type RevealSubject
} from "@ai-orchestrator/shared";
import type { GuardRunResolution, ResolvedGuardProfile } from "@ai-orchestrator/workflow-engine";
import type { ContentRedactionStore } from "../db/content-redaction-store.js";
import type { GuardEventInsert } from "../db/database.js";
import type { AuditEventInput } from "./audit-service.js";
import { ContentScanSettings } from "./content-scan-settings.js";
import { openRedactionMap, storeRedactionMap, type ContentRedactionMap, type ContentRedactionSealer } from "./content-redaction-books.js";
import { gatewayVaultScope } from "./guard-service.js";
import { DocumentError } from "@ai-orchestrator/workflow-engine";
import { DocumentScanBusyError, documentScanResult, type ContentDocumentScanService, type LoadedDocument } from "./content-document-scan-service.js";

/** What the service needs of GuardService. */
export interface ContentToolsGuard {
  loadProfile(profileId: string): Promise<ResolvedGuardProfile | undefined>;
  resolveGateway(context: { toolsetId: string; clientId: string; projectId?: string | null }): Promise<{ resolution: GuardRunResolution }>;
  vaultFor(scope: { projectId?: string | null; executionId?: string | null }): TokenVaultStorage;
  recordGatewayToolEvents(rows: GuardEventInsert[]): Promise<void>;
}

export interface ContentRulesToolsOptions {
  store: ContentRedactionStore;
  sealer: ContentRedactionSealer;
  guard: ContentToolsGuard;
  audit: (event: AuditEventInput) => Promise<unknown> | unknown;
  /** The longest a redaction can be restored (CONTENT_REDACTION_TTL_SECONDS). */
  ttlSeconds: number;
  /** The keyed-hash key of a project scope (derived from the master key); undefined: the hash style is unavailable. */
  hashKey?: (projectScope: string) => Uint8Array | undefined;
  /** The deployment's recognizer for names and addresses (asked for in `entity_types` or by the rule set); absent: the built-in rules. */
  entityRecognizer?: GuardEntityRecognizer;
  /** Document scans (`scan_document`); absent: the tool fails on this deployment. */
  documents?: ContentDocumentScanService;
  /** A rule set's scan settings (warns once per version about invalid stored names and addresses options). */
  scanSettings?: ContentScanSettings;
  now?: () => Date;
}

export interface ContentToolCall {
  tool: ContentRulesGatewayToolName;
  args: Record<string, unknown>;
  /** The toolset member's rule set; null: the built-in detector defaults. */
  memberRuleSetId: string | null;
  /** The member's document options (`scan_document`); absent: off. */
  documents?: ContentRulesDocumentsOptions;
  client: { id: string; name: string };
  toolset: { id: string; projectId: string | null };
  /** The call's synthetic `mcpgw_*` execution id: its rule events are recorded under it. */
  callExecutionId: string;
  /** Aborted when the client goes away or cancels the call: a document fetch and the names and addresses check stop. */
  signal?: AbortSignal;
}

export type ContentToolOutcome =
  | { ok: true; result: Record<string, unknown>; summary: string; restoredClasses: string[]; /** The result carries content fetched from outside (a URL). */ externalContent?: boolean }
  | { ok: false; message: string };

/** A tool error the client can read (never a value). */
class ContentToolError extends Error {}

interface ScannedString {
  path?: string;
  text: string;
  matches: DlpMatch[];
  findings: ContentToolFinding[];
}

interface ScannedInput {
  index: number;
  strings: ScannedString[];
  riskLevel: RiskLevel;
}

/**
 * The keyed-hash key of a project scope: HKDF-SHA-256 of the master key, the scope in the info, so the hash style's
 * output is stable within a project and cannot be linked across projects.
 */
export function deriveContentHashKey(masterKey: Uint8Array, projectScope: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", masterKey, new Uint8Array(0), `l2m/content-rules-hash/v1\u0000${projectScope}`, 32));
}

/** Masked previews a rule event keeps per data class. */
const EVENT_SAMPLES = 5;

const BUILT_IN_REF = { profileId: GUARD_BUILTIN_PROFILE_ID, version: 0, hash: "" };

function countsOf(findings: ReadonlyArray<{ dataClass: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.dataClass] = (counts[finding.dataClass] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function issues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((issue) => `${issue.path.map(String).join(".") || "arguments"}: ${issue.message}`).join("; ");
}

export class ContentRulesToolsService {
  private readonly now: () => Date;

  private readonly scanSettings: ContentScanSettings;

  constructor(private readonly options: ContentRulesToolsOptions) {
    this.now = options.now ?? (() => new Date());
    this.scanSettings = options.scanSettings ?? new ContentScanSettings();
  }

  /** The project scope of a toolset: its project, or `gateway:<toolsetId>` for a toolset without one. */
  static projectScope(toolset: { id: string; projectId: string | null }): string {
    return toolset.projectId ?? gatewayVaultScope(toolset.id);
  }

  async call(call: ContentToolCall): Promise<ContentToolOutcome> {
    try {
      switch (call.tool) {
        case "detect_sensitive_data":
          return await this.detect(call);
        case "redact_sensitive_data":
          return await this.redact(call);
        case "restore_sensitive_data":
          return await this.restore(call);
        case SCAN_DOCUMENT_TOOL_NAME:
          return await this.scanDocument(call);
        default:
          return { ok: false, message: `Unknown content rules tool '${String(call.tool)}'` };
      }
    } catch (error) {
      if (error instanceof ContentToolError) return { ok: false, message: error.message };
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Rule sets
  // ---------------------------------------------------------------------------

  /**
   * The rule set a call detects with: the one it names, when the toolset makes it available (its member's rule set,
   * or one of the call's gateway rule sets), else the member's. A member's rule set that no longer exists fails the
   * call (rather than detect without its allow-list and dictionaries).
   */
  private async ruleSetFor(call: ContentToolCall, requested: string | undefined): Promise<ResolvedGuardProfile | null> {
    const id = requested ?? call.memberRuleSetId;
    if (!id) return null;
    if (requested && requested !== call.memberRuleSetId) {
      const { resolution } = await this.options.guard.resolveGateway({ toolsetId: call.toolset.id, clientId: call.client.id, projectId: call.toolset.projectId });
      if (!resolution.stack.some((entry) => entry.profileId === requested)) {
        throw new ContentToolError(`Rule set '${requested}' is not available to this toolset`);
      }
    }
    const loaded = await this.options.guard.loadProfile(id);
    if (!loaded) throw new ContentToolError(`Rule set '${id}' no longer exists; ask an admin to update the toolset`);
    return loaded;
  }

  private settingsOf(ruleSet: ResolvedGuardProfile | null): SensitiveScanSettings {
    return this.scanSettings.settingsOf(ruleSet ? { id: ruleSet.profileId, version: ruleSet.version, profile: ruleSet.profile } : null);
  }

  // ---------------------------------------------------------------------------
  // Inputs
  // ---------------------------------------------------------------------------

  private static inputsOf(args: { text?: string; texts?: string[]; value?: unknown }): Array<{ index: number; strings: Array<{ path?: string; text: string }> }> {
    let inputs: Array<{ index: number; strings: Array<{ path?: string; text: string }> }>;
    if (args.text !== undefined) inputs = [{ index: 0, strings: [{ text: args.text }] }];
    else if (args.texts !== undefined) inputs = args.texts.map((text, index) => ({ index, strings: [{ text }] }));
    else {
      let refs: ReturnType<typeof stringsIn>;
      try {
        refs = stringsIn(args.value);
      } catch (error) {
        if (error instanceof JsonTooDeepError) throw new ContentToolError(error.message);
        throw error;
      }
      inputs = [{ index: 0, strings: refs.map((ref) => ({ path: ref.path, text: ref.text })) }];
    }
    const total = inputs.reduce((sum, input) => sum + input.strings.reduce((chars, entry) => chars + entry.text.length, 0), 0);
    if (total > CONTENT_TOOLS_MAX_CHARS) throw new ContentToolError(`The input holds ${total} characters; the limit is ${CONTENT_TOOLS_MAX_CHARS}`);
    return inputs;
  }

  private async scan(
    inputs: ReturnType<typeof ContentRulesToolsService.inputsOf>,
    settings: SensitiveScanSettings,
    request: { entityTypes?: string[]; allowList?: string[]; signal?: AbortSignal }
  ): Promise<ScannedInput[]> {
    const scanRequest = {
      ...(request.entityTypes ? { entityTypes: request.entityTypes } : {}),
      ...(request.allowList ? { allowList: { values: request.allowList } } : {})
    };
    // The input is already capped at CONTENT_TOOLS_MAX_CHARS in all, so names and addresses are looked for in all of it.
    const context = {
      ...(this.options.entityRecognizer ? { recognizer: this.options.entityRecognizer } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      maxChars: CONTENT_TOOLS_MAX_CHARS
    };
    const out: ScannedInput[] = [];
    for (const input of inputs) {
      const strings: ScannedString[] = [];
      for (const entry of input.strings) {
        let scanned: Awaited<ReturnType<typeof scanSensitiveTextAsync>>;
        try {
          scanned = await scanSensitiveTextAsync(entry.text, settings, scanRequest, context);
        } catch (error) {
          if (!(error instanceof EntityScanError)) throw error;
          // The recognizer's own message stays on the server: it could quote the input.
          throw new ContentToolError("Names and addresses could not be checked; try again, or leave person_name, location and street_address out of entity_types");
        }
        strings.push({
          ...(entry.path !== undefined ? { path: entry.path } : {}),
          text: entry.text,
          matches: scanned.matches,
          findings: scanned.findings.map((finding) => ({
            dataClass: finding.dataClass,
            ...(entry.path !== undefined ? { path: entry.path } : {}),
            start: finding.start,
            end: finding.end,
            score: finding.score,
            preview: finding.preview
          }))
        });
      }
      out.push({ index: input.index, strings, riskLevel: riskLevelOf(strings.flatMap((entry) => entry.findings)) });
    }
    return out;
  }

  private static inputView(input: ScannedInput, withFindings: boolean): ContentToolInputResult | Omit<ContentToolInputResult, "findings"> {
    const findings = input.strings.flatMap((entry) => entry.findings);
    return { index: input.index, riskLevel: input.riskLevel, ...(withFindings ? { findings } : {}), counts: countsOf(findings) };
  }

  // ---------------------------------------------------------------------------
  // Rule events
  // ---------------------------------------------------------------------------

  /** One rule event per data class per call (highest score, count, up to EVENT_SAMPLES masked previews): bounded rows. */
  private findingRows(call: ContentToolCall, scanned: ScannedInput[], ruleSet: ResolvedGuardProfile | null, action: string): GuardEventInsert[] {
    const samples = scanned.flatMap((input) =>
      input.strings.flatMap((entry) =>
        entry.findings.map((finding) => ({
          dataClass: finding.dataClass,
          score: finding.score,
          evidence: finding.preview,
          spans: [{ start: finding.start, end: finding.end }],
          message: `${call.tool}: ${finding.dataClass} (input ${input.index})`
        }))
      )
    );
    return this.eventRows(call, ruleSet, action, "tool_arguments", samples);
  }

  /**
   * Rule event rows from findings: one per data class (highest score, count, up to EVENT_SAMPLES masked previews).
   * `counts` gives the full count per class when `findings` lists only some of them.
   */
  private eventRows(
    call: ContentToolCall,
    ruleSet: ResolvedGuardProfile | null,
    action: string,
    channel: string,
    findings: Array<{ dataClass: string; score: number; evidence: string; spans: Array<{ start: number; end: number }>; message: string }>,
    counts?: Record<string, number>,
    scores?: Record<string, number>
  ): GuardEventInsert[] {
    const verdictId = randomUUID();
    const createdAt = this.now().toISOString();
    const ref = ruleSet ? { profileId: ruleSet.profileId, version: ruleSet.version, hash: ruleSet.hash } : BUILT_IN_REF;
    const byClass = new Map<string, { score: number; count: number; samples: Array<{ evidence: string; spans: Array<{ start: number; end: number }>; message: string }> }>();
    for (const finding of findings) {
      const group = byClass.get(finding.dataClass) ?? { score: 0, count: 0, samples: [] };
      group.score = Math.max(group.score, finding.score);
      group.count += 1;
      if (group.samples.length < EVENT_SAMPLES) group.samples.push({ evidence: finding.evidence, spans: finding.spans, message: finding.message });
      byClass.set(finding.dataClass, group);
    }
    for (const [dataClass, count] of Object.entries(counts ?? {})) {
      const group = byClass.get(dataClass) ?? { score: scores?.[dataClass] ?? 0, count: 0, samples: [] };
      group.count = Math.max(group.count, count);
      group.score = Math.max(group.score, scores?.[dataClass] ?? 0);
      byClass.set(dataClass, group);
    }
    return [...byClass.entries()].map(([dataClass, group]) => ({
      id: randomUUID(),
      verdictId,
      executionId: call.callExecutionId,
      workflowId: null,
      projectId: call.toolset.projectId,
      nodeId: call.tool,
      placement: "gateway",
      iteration: null,
      toolName: call.tool,
      channel,
      detectorId: isEntityDataClass(dataClass) ? ENTITIES_DETECTOR_ID : DLP_DETECTOR_ID,
      category: "sensitive_data",
      dataClass,
      score: group.score,
      requestedAction: action,
      effectiveAction: action,
      verdictAction: action,
      shadow: false,
      evidence: [
        ...group.samples,
        ...(group.count > group.samples.length ? [{ evidence: "", spans: [], message: `${call.tool}: ${group.count} ${dataClass} findings in all` }] : [])
      ],
      profileId: ref.profileId,
      profileVersion: ref.version,
      profileHash: ref.hash,
      latencyMs: 0,
      budgetExceeded: false,
      skippedDetectors: [],
      createdAt
    }));
  }

  // ---------------------------------------------------------------------------
  // detect_sensitive_data
  // ---------------------------------------------------------------------------

  private async detect(call: ContentToolCall): Promise<ContentToolOutcome> {
    const parsed = detectSensitiveDataArgsSchema.safeParse(call.args);
    if (!parsed.success) return { ok: false, message: `Invalid arguments: ${issues(parsed.error)}` };
    const args = parsed.data;
    const ruleSet = await this.ruleSetFor(call, args.rule_set_id);
    const scanned = await this.scan(ContentRulesToolsService.inputsOf(args), this.settingsOf(ruleSet), {
      ...(args.entity_types ? { entityTypes: args.entity_types } : {}),
      ...(args.allow_list ? { allowList: args.allow_list } : {}),
      ...(call.signal ? { signal: call.signal } : {})
    });
    await this.options.guard.recordGatewayToolEvents(this.findingRows(call, scanned, ruleSet, "allow"));
    const riskLevel = highestRiskLevel(scanned.map((input) => input.riskLevel));
    const total = scanned.reduce((sum, input) => sum + input.strings.reduce((count, entry) => count + entry.findings.length, 0), 0);
    return {
      ok: true,
      result: {
        riskLevel,
        inputs: scanned.map((input) => ContentRulesToolsService.inputView(input, true)),
        ruleSet: ruleSet ? { id: ruleSet.profileId, version: ruleSet.version } : null
      },
      summary: `${total} finding${total === 1 ? "" : "s"}; risk ${riskLevel}`,
      restoredClasses: []
    };
  }

  // ---------------------------------------------------------------------------
  // redact_sensitive_data
  // ---------------------------------------------------------------------------

  private hashProtector(scope: string): (value: string, dataClass: string) => Promise<string> {
    const key = this.options.hashKey?.(scope);
    if (!key || key.length < 16) throw new ContentToolError("The hash style needs the deployment's master key; use placeholder, token or mask");
    return async (value, dataClass) => `hash_${dataClass}_${createHmac("sha256", key).update(`${dataClass}\u0000${value}`).digest("hex").slice(0, 24)}`;
  }

  private ttlMs(requested: number | undefined): number {
    const max = Math.max(CONTENT_REDACTION_MIN_TTL_SECONDS, this.options.ttlSeconds);
    return Math.min(max, requested ?? max) * 1000;
  }

  private async redact(call: ContentToolCall): Promise<ContentToolOutcome> {
    const parsed = redactSensitiveDataArgsSchema.safeParse(call.args);
    if (!parsed.success) return { ok: false, message: `Invalid arguments: ${issues(parsed.error)}` };
    const args = parsed.data;
    const style: RedactionStyle = args.style;
    const ruleSet = await this.ruleSetFor(call, args.rule_set_id);
    const inputs = ContentRulesToolsService.inputsOf(args);
    const scanned = await this.scan(inputs, this.settingsOf(ruleSet), {
      ...(args.entity_types ? { entityTypes: args.entity_types } : {}),
      ...(args.allow_list ? { allowList: args.allow_list } : {}),
      ...(call.signal ? { signal: call.signal } : {})
    });
    const scope = ContentRulesToolsService.projectScope(call.toolset);
    // Keys are scanned but never rewritten: a key that holds sensitive data refuses the call rather than pass it on.
    const sensitiveKey = scanned.flatMap((input) => input.strings).find((entry) => entry.path?.endsWith("{key}") && entry.matches.length > 0);
    if (sensitiveKey) throw new ContentToolError(`An object key holds sensitive data (${sensitiveKey.path}); keys cannot be redacted, so send it as a value`);

    // Placeholders already in any input are reserved, so a typed `[EMAIL_1]` never reads as one this call issued.
    const { book, tokens, protect } = this.protectorFor(style, call, scope, new Set(scanned.flatMap((input) => input.strings.flatMap((entry) => [...placeholdersIn(entry.text)]))));

    // Each string's matches, keyed by input and path, rewritten in place.
    const byKey = new Map<string, ScannedString>();
    for (const input of scanned) for (const entry of input.strings) byKey.set(`${input.index}\u0000${entry.path ?? ""}`, entry);
    const rewrite = async (index: number, text: string, path?: string) => {
      const entry = byKey.get(`${index}\u0000${path ?? ""}`);
      return entry && entry.text === text && entry.matches.length > 0 ? await rewriteMatches(text, entry.matches, protect) : text;
    };
    let redacted: unknown;
    if (args.text !== undefined) redacted = await rewrite(0, args.text);
    else if (args.texts !== undefined) {
      const out: string[] = [];
      for (const [index, text] of args.texts.entries()) out.push(await rewrite(index, text));
      redacted = out;
    } else redacted = await mapStrings(args.value, async (text, path) => await rewrite(0, text, path));

    const findings = scanned.flatMap((input) => input.strings.flatMap((entry) => entry.findings));
    const { redactionId, expiresAt } = await this.keepRedaction(call, scope, style, book, tokens, args.ttl_seconds);
    const action = style === "mask" ? "mask" : style === "placeholder" ? "redact" : "protect";
    await this.options.guard.recordGatewayToolEvents(this.findingRows(call, scanned, ruleSet, action));
    const riskLevel = highestRiskLevel(scanned.map((input) => input.riskLevel));
    return {
      ok: true,
      result: {
        style,
        redacted,
        riskLevel,
        counts: countsOf(findings),
        inputs: scanned.map((input) => ContentRulesToolsService.inputView(input, false)),
        ...(redactionId ? { redaction_id: redactionId, expires_at: expiresAt } : {}),
        ruleSet: ruleSet ? { id: ruleSet.profileId, version: ruleSet.version } : null
      },
      summary: `${findings.length} value${findings.length === 1 ? "" : "s"} redacted (${style})`,
      restoredClasses: []
    };
  }

  /** What a redaction style replaces a value with; placeholder and token styles fill `book` and `tokens`. */
  private protectorFor(style: RedactionStyle, call: ContentToolCall, scope: string, reserved: ReadonlySet<string>) {
    const book = new InMemoryPlaceholderBook();
    const tokens: ContentRedactionMap["tokens"] = [];
    const vault = style === "token" ? this.options.guard.vaultFor({ projectId: scope, executionId: call.callExecutionId }) : undefined;
    const tokenProvider = vault ? createTokenVaultProvider({ storage: vault }) : undefined;
    const protect: (value: string, dataClass: string) => Promise<string> =
      style === "placeholder"
        ? async (value, dataClass) => book.assignNow(dataClass, value, reserved).placeholder
        : style === "token"
          ? async (value, dataClass) => {
              const token = await tokenProvider!.protect(value, { dataClass });
              tokens.push({ token, dataClass });
              return token;
            }
          : style === "hash"
            ? this.hashProtector(scope)
            : async (value, dataClass) => maskForDataClass(value, dataClass);
    return { book, tokens, protect };
  }

  /** Keeps a reversible redaction's map (sealed, expiring, bound to the client and project scope); one-way styles keep nothing. */
  private async keepRedaction(
    call: ContentToolCall,
    scope: string,
    style: RedactionStyle,
    book: InMemoryPlaceholderBook,
    tokens: ContentRedactionMap["tokens"],
    ttlSeconds: number | undefined
  ): Promise<{ redactionId?: string; expiresAt?: string }> {
    const reversible = style === "placeholder" || style === "token";
    const state = book.state();
    if (!reversible || (state.entries.length === 0 && tokens.length === 0)) return {};
    const redactionId = `red_${randomBytes(18).toString("base64url")}`;
    const record = await storeRedactionMap(
      this.options.store,
      this.options.sealer,
      { id: redactionId, scope: "gateway", clientId: call.client.id, toolsetId: call.toolset.id, projectId: scope, executionId: call.callExecutionId },
      { book: state, tokens },
      { now: this.now(), ttlMs: this.ttlMs(ttlSeconds) }
    );
    return { redactionId, expiresAt: record.expiresAt };
  }

  // ---------------------------------------------------------------------------
  // scan_document
  // ---------------------------------------------------------------------------

  /**
   * A document sent as base64 or, when the member allows URLs, fetched from a listed host (private, loopback and
   * link-local addresses always refused). Findings with locations and masked previews, a risk level, and optionally
   * the redacted text. Rule events carry masked evidence; the audit entry carries the origin, a hash of the path,
   * the size, the type and the counts, never content.
   */
  private async scanDocument(call: ContentToolCall): Promise<ContentToolOutcome> {
    const documents = call.documents;
    const scanner = this.options.documents;
    if (!documents?.enabled) return { ok: false, message: "Document scanning is not turned on for this toolset" };
    if (!scanner) return { ok: false, message: "Document scanning is not available on this deployment" };
    const parsed = scanDocumentArgsSchema.safeParse(call.args);
    if (!parsed.success) return { ok: false, message: `Invalid arguments: ${issues(parsed.error)}` };
    const args = parsed.data;
    if (args.url !== undefined && !documents.allowUrls) return { ok: false, message: "This toolset does not allow fetching documents from URLs; send the content as content_base64" };
    const ruleSet = await this.ruleSetFor(call, args.rule_set_id);
    const scope = ContentRulesToolsService.projectScope(call.toolset);
    let sourceRef: Record<string, unknown> = args.url !== undefined ? ContentRulesToolsService.originOf(args.url) : { source: "upload" };

    try {
      return await scanner.forGatewayClient(call.client.id, async () =>
        await scanner.withSlot(async () => {
          const loaded: LoadedDocument =
            args.url !== undefined
              ? await scanner.fetchUrl(args.url, { gateway: true, allowHost: (target) => documentHostAllowed(target, documents.allowedHosts) }, call.signal)
              : { bytes: scanner.decodeUpload(args.content_base64!), mediaType: args.media_type ?? null, source: { kind: "upload", ...(args.filename ? { filename: args.filename } : {}) } };
          if (loaded.source.kind === "url") sourceRef = { source: loaded.source.origin, pathHash: loaded.source.pathHash };
          // A fetched document's declared type is the server's; an upload's is the caller's.
          const extracted = scanner.extract(loaded.source.kind === "upload" ? loaded : { ...loaded, mediaType: loaded.mediaType ?? args.media_type ?? null });
          const style = args.redact_style;
          const protector = style ? this.protectorFor(style, call, scope, new Set(extracted.segments.flatMap((segment) => [...placeholdersIn(segment.text)]))) : undefined;
          const outcome = await scanner.scan(
            extracted,
            loaded,
            ruleSet ? { id: ruleSet.profileId, version: ruleSet.version, profile: ruleSet.profile } : null,
            {
              ...(args.entity_types ? { entityTypes: args.entity_types } : {}),
              ...(args.allow_list ? { allowList: { values: args.allow_list } } : {})
            },
            protector?.protect,
            call.signal
          );
          const kept = style && protector ? await this.keepRedaction(call, scope, style, protector.book, protector.tokens, args.ttl_seconds) : {};
          const result: DocumentScanResult = documentScanResult(
            extracted,
            loaded,
            outcome,
            ruleSet ? { id: ruleSet.profileId, version: ruleSet.version } : null,
            style && outcome.redactedText !== undefined
              ? { style, text: outcome.redactedText, ...(kept.redactionId ? { redaction_id: kept.redactionId, expires_at: kept.expiresAt! } : {}) }
              : undefined
          );
          const action = !style ? "allow" : style === "mask" ? "mask" : style === "placeholder" ? "redact" : "protect";
          await this.options.guard.recordGatewayToolEvents(
            this.eventRows(
              call,
              ruleSet,
              action,
              loaded.source.kind === "url" ? "tool_result" : "tool_arguments",
              outcome.findings.map((finding) => ({ dataClass: finding.dataClass, score: finding.score, evidence: finding.maskedPreview, spans: [], message: `${call.tool}: ${finding.dataClass} in a ${finding.location.kind} document` })),
              outcome.countsByClass,
              outcome.maxScoreByClass
            )
          );
          await this.auditDocumentScan(call, "success", {
            ...sourceRef,
            bytes: result.bytes,
            type: result.sniffedType,
            typeMismatch: result.typeMismatch,
            truncated: result.truncated,
            findings: outcome.total,
            counts: result.countsByClass,
            riskLevel: result.riskLevel,
            ...(style ? { redactStyle: style } : {})
          });
          const total = outcome.total;
          return { ok: true, result: result as unknown as Record<string, unknown>, summary: `${total} finding${total === 1 ? "" : "s"}; risk ${result.riskLevel}`, restoredClasses: [], ...(loaded.source.kind === "url" ? { externalContent: true } : {}) };
        })
      );
    } catch (error) {
      if (error instanceof DocumentError || error instanceof DocumentScanBusyError) {
        await this.auditDocumentScan(call, error instanceof DocumentError && error.code === "host_not_allowed" ? "denied" : "failure", {
          ...sourceRef,
          ...(error instanceof DocumentError ? { code: error.code, ...(error.reason ? { reason: error.reason } : {}) } : { code: "busy" })
        });
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }

  /** The origin of a URL argument for the audit (never its path or query). */
  private static originOf(url: string): Record<string, unknown> {
    try {
      const parsed = new URL(url);
      return { source: parsed.origin, pathHash: createHash("sha256").update(`${parsed.pathname}${parsed.search}`).digest("hex").slice(0, 16) };
    } catch {
      return { source: "url" };
    }
  }

  private async auditDocumentScan(call: ContentToolCall, outcome: "success" | "failure" | "denied", metadata: Record<string, unknown>): Promise<void> {
    await this.options.audit({
      eventType: "mcp_gateway.content_document_scan",
      category: "system",
      action: "execute",
      outcome,
      actor: { type: "api_key", email: call.client.name },
      resourceType: "mcp_toolset",
      resourceId: call.toolset.id,
      projectId: call.toolset.projectId,
      metadata: { clientId: call.client.id, executionId: call.callExecutionId, ...metadata },
      message: outcome === "success" ? "Document scanned through the MCP gateway" : "Document scan through the MCP gateway refused or failed"
    });
  }

  // ---------------------------------------------------------------------------
  // restore_sensitive_data
  // ---------------------------------------------------------------------------

  /** Reveal rules that apply to a gateway call: the member's rule set and the call's gateway rule sets (ceiling as in runs). */
  private async revealRuleEntries(call: ContentToolCall): Promise<Array<{ rule: RevealRule; profile: ResolvedGuardProfile; index: number }>> {
    const { resolution } = await this.options.guard.resolveGateway({ toolsetId: call.toolset.id, clientId: call.client.id, projectId: call.toolset.projectId });
    const enforced = resolution.enforced;
    let profiles: ResolvedGuardProfile[];
    if (enforced?.profile.reveal) {
      profiles = [enforced];
    } else {
      const member = call.memberRuleSetId ? await this.options.guard.loadProfile(call.memberRuleSetId) : undefined;
      const seen = new Set<string>();
      profiles = [...(member ? [member] : []), ...resolution.stack].filter((entry) => (seen.has(entry.hash) ? false : (seen.add(entry.hash), true)));
    }
    return profiles.flatMap((profile) => profileRevealRules(profile.profile).map((rule, index) => ({ rule, profile, index })));
  }

  /** The audit entry of a restore call: client, toolset, counts per class and the redaction id's hash; never values. */
  private async auditRestore(
    call: ContentToolCall,
    redactionId: string | undefined,
    detail: { outcome: "success" | "denied" | "failure"; reason?: string; revealed: Array<Record<string, unknown>>; withheld: Array<Record<string, unknown>> }
  ): Promise<void> {
    const restored = detail.revealed.reduce((total, entry) => total + Number(entry.count ?? 0), 0);
    const withheld = detail.withheld.reduce((total, entry) => total + Number(entry.count ?? 0), 0);
    await this.options.audit({
      eventType: "mcp_gateway.content_restore",
      category: "system",
      action: "reveal",
      outcome: detail.outcome,
      actor: { type: "api_key", email: call.client.name },
      resourceType: "mcp_toolset",
      resourceId: call.toolset.id,
      projectId: call.toolset.projectId,
      metadata: {
        clientId: call.client.id,
        executionId: call.callExecutionId,
        ...(redactionId ? { redactionIdHash: createHash("sha256").update(redactionId).digest("hex").slice(0, 16) } : {}),
        ...(detail.reason ? { reason: detail.reason } : {}),
        revealed: detail.revealed,
        withheld: detail.withheld
      },
      message: detail.reason ? `Restore through the MCP gateway refused (${detail.reason})` : `Restore through the MCP gateway: restored ${restored}, withheld ${withheld}`
    });
  }

  private async restore(call: ContentToolCall): Promise<ContentToolOutcome> {
    const parsed = restoreSensitiveDataArgsSchema.safeParse(call.args);
    if (!parsed.success) return { ok: false, message: `Invalid arguments: ${issues(parsed.error)}` };
    const args = parsed.data;
    const scope = ContentRulesToolsService.projectScope(call.toolset);
    // The same size limit as the other tools.
    ContentRulesToolsService.inputsOf(args);

    let book: InMemoryPlaceholderBook | undefined;
    // Vault tokens restore only through the redaction that issued them: listed in its map and issued by its call.
    let issuedTokens: Map<string, string> | undefined;
    let issuedBy: string | null = null;
    if (args.redaction_id) {
      // Expired maps go at every restore too, so they do not wait on disk for the next redact.
      await this.options.store.deleteExpiredContentRedactions(this.now().toISOString());
      const row = await this.options.store.getContentRedaction(args.redaction_id, this.now().toISOString());
      // Another client's or another project's redaction reads as unknown: nothing tells the caller it exists.
      if (!row || row.scope !== "gateway" || row.clientId !== call.client.id || row.projectId !== scope) {
        await this.auditRestore(call, args.redaction_id, { outcome: "denied", reason: "unknown_redaction", revealed: [], withheld: [] });
        throw new ContentToolError("Unknown or expired redaction_id");
      }
      let map: ContentRedactionMap;
      try {
        map = openRedactionMap(this.options.sealer, row.entriesSealed);
      } catch {
        await this.auditRestore(call, args.redaction_id, { outcome: "failure", reason: "unopenable_redaction", revealed: [], withheld: [] });
        throw new ContentToolError("This redaction can no longer be opened (the deployment's key changed)");
      }
      book = new InMemoryPlaceholderBook(map.book);
      issuedTokens = new Map(map.tokens.map((entry) => [entry.token, entry.dataClass]));
      issuedBy = row.executionId;
    }

    const entries = await this.revealRuleEntries(call);
    const subject: RevealSubject = { source: REVEAL_GATEWAY_CLIENT_SOURCE, gatewayClientId: call.client.id };
    const rules = entries.map((entry) => entry.rule);
    const needsApproval = new Set<string>();
    const grant = (dataClass: string) => {
      const rule = findRevealRule(rules, { subject, dataClass, workflowId: null });
      const entry = rule ? entries[rules.indexOf(rule)] : undefined;
      if (!entry) return undefined;
      if (entry.rule.requireApproval) {
        needsApproval.add(dataClass);
        return undefined;
      }
      return { rule: { profileId: entry.profile.profileId, version: entry.profile.version, index: entry.index, ...(entry.rule.name ? { name: entry.rule.name } : {}) } };
    };
    const allowedClasses = [...new Set(entries.flatMap((entry) => entry.rule.dataClasses.filter((dataClass) => grant(dataClass) !== undefined)))].sort();
    needsApproval.clear();

    const content = args.text !== undefined ? args.text : args.texts !== undefined ? args.texts : args.value;
    const projectVault = this.options.guard.vaultFor({ projectId: scope, executionId: call.callExecutionId });
    const redactionVault: TokenVaultStorage = {
      getByToken: async (token) => {
        if (!issuedTokens?.has(token)) return undefined;
        const record = await projectVault.getByToken(token);
        return record && record.executionId === issuedBy && record.dataClass === issuedTokens.get(token) ? record : undefined;
      },
      getByValueHash: async () => undefined,
      put: async () => {
        throw new ContentToolError("Restore does not issue tokens");
      }
    };
    const result = await revealTokens(content, {
      vault: redactionVault,
      ...(book ? { placeholders: book } : {}),
      grant,
      allowedClasses,
      projectId: scope,
      allowUnscoped: false
    });
    const refused: RevealClassSummary[] = result.refused.map((entry) =>
      entry.reason === "no_rule" && entry.dataClass && needsApproval.has(entry.dataClass) ? { ...entry, reason: "approval_required" } : entry
    );
    const revealedCount = result.revealed.reduce((total, entry) => total + entry.count, 0);
    const refusedCount = refused.reduce((total, entry) => total + entry.count, 0);

    // The audit entry first, for every restore: one that cannot be recorded gives nothing back.
    await this.auditRestore(call, args.redaction_id, {
      outcome: revealedCount > 0 ? "success" : "denied",
      revealed: result.revealed.map((entry) => ({ dataClass: entry.dataClass ?? null, count: entry.count, ...(entry.rule ? { rule: entry.rule } : {}) })),
      withheld: refused.map((entry) => ({ dataClass: entry.dataClass ?? null, count: entry.count, reason: entry.reason ?? null }))
    });
    if (revealedCount > 0 || refusedCount > 0) {
      await this.options.guard.recordGatewayToolEvents(this.restoreRows(call, result.revealed, refused, entries));
    }
    return {
      ok: true,
      result: {
        restored: result.content,
        restoredClasses: result.revealed.map((entry) => ({ dataClass: entry.dataClass, count: entry.count })),
        withheld: refused.map((entry) => ({ ...(entry.dataClass ? { dataClass: entry.dataClass } : {}), count: entry.count, reason: entry.reason }))
      },
      summary: `${revealedCount} restored, ${refusedCount} withheld`,
      restoredClasses: result.revealedClasses
    };
  }

  /** Restore rule events: one row per restored class and per withheld class and reason, with token hashes only. */
  private restoreRows(
    call: ContentToolCall,
    revealed: RevealClassSummary[],
    refused: RevealClassSummary[],
    entries: Array<{ profile: ResolvedGuardProfile }>
  ): GuardEventInsert[] {
    const verdictId = randomUUID();
    const createdAt = this.now().toISOString();
    const profiles = entries.map((entry) => entry.profile);
    const fallback = profiles[0] ? { profileId: profiles[0].profileId, version: profiles[0].version, hash: profiles[0].hash } : BUILT_IN_REF;
    const refOf = (rule?: { profileId: string; version: number }) => {
      const match = rule ? profiles.find((profile) => profile.profileId === rule.profileId && profile.version === rule.version) : undefined;
      return match ? { profileId: match.profileId, version: match.version, hash: match.hash } : fallback;
    };
    const row = (entry: RevealClassSummary, restored: boolean): GuardEventInsert => {
      const ref = refOf(entry.rule);
      const message = restored ? `Restored ${entry.count} value${entry.count === 1 ? "" : "s"} for gateway client ${call.client.id}` : `Withheld ${entry.count}: ${entry.reason ?? "no_rule"}`;
      return {
        id: randomUUID(),
        verdictId,
        executionId: call.callExecutionId,
        workflowId: null,
        projectId: call.toolset.projectId,
        nodeId: call.tool,
        placement: "gateway",
        iteration: null,
        toolName: call.tool,
        channel: "reveal",
        detectorId: REVEAL_EVENT_DETECTOR_ID,
        category: REVEAL_EVENT_DETECTOR_ID,
        dataClass: entry.dataClass ?? null,
        score: null,
        requestedAction: "reveal",
        effectiveAction: restored ? "reveal" : "block",
        verdictAction: "reveal",
        shadow: false,
        evidence: (entry.tokenHashes.length > 0 ? entry.tokenHashes : [""]).map((hash) => ({ evidence: hash ? `sha256:${hash}` : "", spans: [], message })),
        profileId: ref.profileId,
        profileVersion: ref.version,
        profileHash: ref.hash,
        latencyMs: 0,
        budgetExceeded: false,
        skippedDetectors: [],
        createdAt
      };
    };
    return [...revealed.map((entry) => row(entry, true)), ...refused.map((entry) => row(entry, false))];
  }
}
