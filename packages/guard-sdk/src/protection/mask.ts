import { maskForDataClass } from "../masking";
import type { ProtectionProvider } from "./types";

export const MASK_PROVIDER_ID = "mask";

/** Irreversible: replaces the value with its masked form. */
export function createMaskProvider(): ProtectionProvider {
  return {
    id: MASK_PROVIDER_ID,
    description: "Masks the value, keeping only the characters usually shown (last four digits, email domain).",
    deterministic: true,
    reversible: false,
    dataClasses: "*",
    async protect(value, context) {
      return maskForDataClass(value, context.dataClass);
    }
  };
}
