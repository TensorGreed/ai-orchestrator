import type { GuardDataClass } from "../types";
import { GuardProtectionError } from "../types";
import type { ProtectionProvider } from "./types";
import { providerSupports } from "./types";

export class ProtectionRegistry {
  private readonly providers = new Map<string, ProtectionProvider>();

  register(provider: ProtectionProvider): this {
    if (this.providers.has(provider.id)) throw new Error(`Protection provider '${provider.id}' is already registered`);
    this.providers.set(provider.id, provider);
    return this;
  }

  replace(provider: ProtectionProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): ProtectionProvider | undefined {
    return this.providers.get(id);
  }

  list(): ProtectionProvider[] {
    return [...this.providers.values()];
  }

  /** The provider, or an error naming why it cannot serve the data class. */
  resolve(id: string, dataClass: GuardDataClass): ProtectionProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new GuardProtectionError(id, `Protection provider '${id}' is not registered`);
    if (!providerSupports(provider, dataClass)) throw new GuardProtectionError(id, `Protection provider '${id}' does not cover data class '${dataClass}'`);
    return provider;
  }
}
