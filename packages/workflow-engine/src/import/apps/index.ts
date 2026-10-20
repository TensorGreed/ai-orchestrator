/**
 * App node handlers for the external workflow import, grouped by domain.
 * `external-builder.ts` builds the kit and registers the result next to the
 * core handlers.
 */
import { chatAppRegistrations } from "./chat.js";
import { crmPaymentsAppRegistrations } from "./crm-payments.js";
import { dataAppRegistrations } from "./data.js";
import { devAppRegistrations } from "./dev.js";
import type { AppKit, AppRegistration } from "./kit.js";

export type { AppKit, AppRegistration } from "./kit.js";

export function createAppRegistrations(kit: AppKit): AppRegistration[] {
  return [...chatAppRegistrations(kit), ...devAppRegistrations(kit), ...dataAppRegistrations(kit), ...crmPaymentsAppRegistrations(kit)];
}
