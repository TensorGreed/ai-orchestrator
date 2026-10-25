import { SURROGATE_REVEAL_REFUSED_MESSAGE } from "@ai-orchestrator/shared";
import type { GuardDataClass } from "../types";

/**
 * Phase 12.5 — protection providers. A provider turns a sensitive value into
 * a token (`protect`) and, when reversible, back (`reveal`). Key material
 * arrives through an injected `KeyResolver`; the package never reads
 * environment variables or files. The wiring layer will supply a resolver
 * backed by SecretService.
 */

export type KeyResolver = (keyId: string) => Promise<Uint8Array | undefined>;

export interface ProtectContext {
  dataClass: GuardDataClass;
  /** Key id to use; providers fall back to their configured default. */
  keyId?: string;
  /** Provider-specific settings from the profile's data-class mapping. */
  options?: Record<string, unknown>;
}

export interface ProtectionProvider {
  id: string;
  description: string;
  /** The same input always yields the same token (joins and lookups keep working). */
  deterministic: boolean;
  reversible: boolean;
  /** Data classes the provider accepts, or `*`. */
  dataClasses: readonly GuardDataClass[] | "*";
  protect(value: string, context: ProtectContext): Promise<string>;
  reveal?(token: string, context: ProtectContext): Promise<string>;
}

/**
 * Phase 16 — why a provider's tokens cannot be revealed, or undefined when
 * they can. A route that offers reveal answers 400 with this text.
 */
export function revealRefusal(provider: Pick<ProtectionProvider, "id" | "reversible">): string | undefined {
  if (provider.id === "surrogate") return SURROGATE_REVEAL_REFUSED_MESSAGE;
  if (!provider.reversible) return `Protection provider '${provider.id}' is one-way; its tokens cannot be turned back into values`;
  return undefined;
}

export function providerSupports(provider: ProtectionProvider, dataClass: GuardDataClass): boolean {
  return provider.dataClasses === "*" || provider.dataClasses.includes(dataClass);
}

/** A key resolver over a fixed map, for tests and single-key deployments. */
export function staticKeyResolver(keys: Record<string, Uint8Array | string>): KeyResolver {
  return async (keyId) => {
    const key = keys[keyId];
    if (key === undefined) return undefined;
    return typeof key === "string" ? Buffer.from(key, "base64") : key;
  };
}
