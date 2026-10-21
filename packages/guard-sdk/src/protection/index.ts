import { createAesGcmProvider } from "./aes-gcm";
import { createKeyedHashProvider } from "./keyed-hash";
import { createMaskProvider } from "./mask";
import { ProtectionRegistry } from "./registry";
import { createTokenVaultProvider, InMemoryTokenVaultStorage, type TokenVaultStorage } from "./token-vault";
import type { KeyResolver } from "./types";

export * from "./types";
export * from "./registry";
export * from "./mask";
export * from "./keyed-hash";
export * from "./aes-gcm";
export * from "./token-vault";

export interface DefaultProtectionOptions {
  /** Key material for keyed hashing, encryption and deterministic tokens. Without it only `mask` and random tokens work. */
  keys?: KeyResolver;
  defaultKeyId?: string;
  /** Vault storage; defaults to an in-memory store, which is for tests and single-process use only. */
  vault?: TokenVaultStorage;
}

export function createDefaultProtectionRegistry(options: DefaultProtectionOptions = {}): ProtectionRegistry {
  const registry = new ProtectionRegistry();
  const keys: KeyResolver = options.keys ?? (async () => undefined);
  registry.register(createMaskProvider());
  registry.register(createKeyedHashProvider({ keys, defaultKeyId: options.defaultKeyId }));
  registry.register(createAesGcmProvider({ keys, defaultKeyId: options.defaultKeyId }));
  registry.register(createTokenVaultProvider({ storage: options.vault ?? new InMemoryTokenVaultStorage(), keys, defaultKeyId: options.defaultKeyId }));
  return registry;
}
