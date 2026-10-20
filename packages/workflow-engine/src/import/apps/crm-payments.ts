/**
 * App handlers: CRM and payments (HubSpot, Salesforce, Stripe).
 */
import type { ConversionContext, ExpressionScope, SourceNode } from "../handler-types.js";
import {
  dispatchOperations,
  eventFilterReason,
  finish,
  jsonTemplate,
  readLocator,
  type AppKit,
  type AppRegistration,
  type OperationHandler
} from "./kit.js";

const BASE = "n8n-nodes-base.";

// --- HubSpot ----------------------------------------------------------------

/** Source builder field names → HubSpot contact property names. */
const HUBSPOT_CONTACT_PROPERTIES: Record<string, string> = {
  email: "email",
  firstName: "firstname",
  lastName: "lastname",
  phoneNumber: "phone",
  mobilePhoneNumber: "mobilephone",
  companyName: "company",
  jobTitle: "jobtitle",
  website: "website",
  city: "city",
  state: "state",
  zip: "zip",
  country: "country",
  streetAddress: "address",
  lifecycleStage: "lifecyclestage",
  leadStatus: "hs_lead_status",
  message: "message",
  industry: "industry",
  salutation: "salutation",
  twitterUsername: "twitterhandle",
  numberOfEmployees: "numemployees",
  annualRevenue: "annualrevenue"
};

function hubspotCredentialType(source: SourceNode): string {
  if ("hubspotOAuth2Api" in source.credentials) return "hubspotOAuth2Api";
  if ("hubspotAppToken" in source.credentials) return "hubspotAppToken";
  return "hubspotApi";
}

const hubspotContactUpsert: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const properties: Record<string, unknown> = { email: params.email };
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(kit.toRecord(params.additionalFields))) {
    const property = HUBSPOT_CONTACT_PROPERTIES[key];
    if (property && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) properties[property] = value;
    else dropped.push(key);
  }
  const config: Record<string, unknown> = {
    secretRef: kit.appSecret(source, ctx, scope, hubspotCredentialType(source), "HubSpot private app token"),
    propertiesJson: jsonTemplate(kit, ctx, scope, "additionalFields", properties)
  };
  const reasons = [
    "Create-or-update became a plain create; an existing contact with the same email will make the call fail instead of updating it.",
    dropped.length ? `Contact fields (${dropped.join(", ")}) are not supported and were dropped.` : undefined
  ];
  return finish(kit, kit.baseNode(source, scope, "hubspot_create_contact", config), reasons);
};

const hubspotContactGet: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const identifier = kit.tpl(params.contactId, ctx, scope, "contactId");
  const config: Record<string, unknown> = {
    secretRef: kit.appSecret(source, ctx, scope, hubspotCredentialType(source), "HubSpot private app token"),
    identifier,
    idProperty: identifier.includes("@") ? "email" : "id"
  };
  const reasons = [
    identifier ? undefined : "No contact id was set; fill in identifier after import.",
    Object.keys(kit.toRecord(params.additionalFields)).length ? "Property selection options are not supported; the default contact properties are returned." : undefined
  ];
  return finish(kit, kit.baseNode(source, scope, "hubspot_get_contact", config), reasons);
};

// --- Salesforce -------------------------------------------------------------

const SALESFORCE_CREDENTIAL_REASON = "The instance URL lives in the source credential; set instanceUrl after import.";

/** Source resource → Salesforce object API name and the top-level parameters that hold required fields. */
const SALESFORCE_OBJECTS: Record<string, { sobject: string; fields: string[] }> = {
  lead: { sobject: "Lead", fields: ["company", "lastname"] },
  contact: { sobject: "Contact", fields: ["lastname"] },
  account: { sobject: "Account", fields: ["name"] },
  opportunity: { sobject: "Opportunity", fields: ["name", "closeDate", "stageName"] },
  case: { sobject: "Case", fields: ["type"] },
  task: { sobject: "Task", fields: ["status"] },
  user: { sobject: "User", fields: [] },
  attachment: { sobject: "Attachment", fields: [] }
};

function salesforceCredentialType(source: SourceNode): string {
  return "salesforceJwtApi" in source.credentials ? "salesforceJwtApi" : "salesforceOAuth2Api";
}

function salesforceBase(source: SourceNode, ctx: ConversionContext, scope: ExpressionScope, kit: AppKit): Record<string, unknown> {
  return {
    instanceUrl: "",
    apiVersion: "v58.0",
    secretRef: kit.appSecret(source, ctx, scope, salesforceCredentialType(source), "Salesforce access token")
  };
}

function salesforceCreate(resource: string): OperationHandler {
  return (source, ctx, scope, kit) => {
    const params = source.parameters;
    const config = salesforceBase(source, ctx, scope, kit);
    const reasons: Array<string | undefined> = [SALESFORCE_CREDENTIAL_REASON];
    const fields: Record<string, unknown> = {};
    const dropped: string[] = [];
    if (resource === "customObject") {
      const object = readLocator(kit, params.customObject).value;
      config.sobject = object.startsWith("=") ? kit.tpl(object, ctx, scope, "customObject") : object;
      if (!object) reasons.push("No custom object was selected; set sobject after import.");
      kit.toArray(kit.toRecord(params.customFieldsUi).customFieldsValues).forEach((entry) => {
        const row = kit.toRecord(entry);
        const fieldId = kit.asString(row.fieldId).trim();
        if (fieldId) fields[fieldId] = row.value;
      });
    } else {
      const object = SALESFORCE_OBJECTS[resource];
      config.sobject = object.sobject;
      for (const key of object.fields) {
        if (params[key] !== undefined) fields[key] = params[key];
      }
    }
    for (const [key, value] of Object.entries(kit.toRecord(params.additionalFields))) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") fields[key] = value;
      else if (key === "customFieldsUi") {
        kit.toArray(kit.toRecord(value).customFieldsValues).forEach((entry) => {
          const row = kit.toRecord(entry);
          const fieldId = kit.asString(row.fieldId).trim();
          if (fieldId) fields[fieldId] = row.value;
        });
      } else dropped.push(key);
    }
    config.fieldsJson = jsonTemplate(kit, ctx, scope, "fields", fields);
    if (dropped.length) reasons.push(`Fields (${dropped.join(", ")}) are not supported and were dropped.`);
    return finish(kit, kit.baseNode(source, scope, "salesforce_create_record", config), reasons);
  };
}

const salesforceSearchQuery: OperationHandler = (source, ctx, scope, kit) => {
  const config = salesforceBase(source, ctx, scope, kit);
  config.soql = kit.tpl(source.parameters.query, ctx, scope, "query");
  return finish(kit, kit.baseNode(source, scope, "salesforce_query", config), [SALESFORCE_CREDENTIAL_REASON]);
};

function salesforceGetAll(resource: string): OperationHandler {
  return (source, ctx, scope, kit) => {
    const params = source.parameters;
    const options = kit.toRecord(params.options);
    const config = salesforceBase(source, ctx, scope, kit);
    const reasons: Array<string | undefined> = [SALESFORCE_CREDENTIAL_REASON];
    const sobject = resource === "customObject" ? readLocator(kit, params.customObject).value : SALESFORCE_OBJECTS[resource].sobject;
    const fields = kit.asString(options.fields).trim();
    const limit = params.returnAll === true ? 200 : Math.min(200, Math.max(1, Math.floor(kit.asNumber(params.limit, 50))));
    config.soql = `SELECT ${fields || "FIELDS(ALL)"} FROM ${sobject} LIMIT ${limit}`;
    reasons.push(`The list operation was rewritten as SOQL (${config.soql}); review it after import.`);
    if (params.returnAll === true) reasons.push("Returning all records is not supported; the first 200 are returned.");
    if (options.conditionsUi !== undefined) reasons.push("Filter conditions are not supported; add a WHERE clause to the SOQL after import.");
    return finish(kit, kit.baseNode(source, scope, "salesforce_query", config), reasons);
  };
}

function salesforceOperations(): Record<string, OperationHandler> {
  const table: Record<string, OperationHandler> = { "search/query": salesforceSearchQuery };
  for (const resource of [...Object.keys(SALESFORCE_OBJECTS), "customObject"]) {
    table[`${resource}/create`] = salesforceCreate(resource);
    table[`${resource}/getAll`] = salesforceGetAll(resource);
  }
  return table;
}

// --- Stripe -----------------------------------------------------------------

function stripeMetadata(kit: AppKit, ctx: ConversionContext, scope: ExpressionScope, raw: unknown, path: string): string | undefined {
  const rows = kit.toArray(kit.toRecord(raw).metadataProperties);
  if (!rows.length) return undefined;
  const metadata: Record<string, unknown> = {};
  rows.forEach((entry) => {
    const row = kit.toRecord(entry);
    const key = kit.asString(row.key).trim();
    if (key) metadata[key] = row.value;
  });
  return jsonTemplate(kit, ctx, scope, path, metadata);
}

function stripeSecret(source: SourceNode, ctx: ConversionContext, scope: ExpressionScope, kit: AppKit): { secretId: string } {
  return kit.appSecret(source, ctx, scope, "stripeApi", "Stripe secret key");
}

const stripeCustomerCreate: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const extra = kit.toRecord(params.additionalFields);
  const config: Record<string, unknown> = { secretRef: stripeSecret(source, ctx, scope, kit) };
  const name = kit.tpl(params.name, ctx, scope, "name");
  if (name) config.name = name;
  const email = kit.tpl(extra.email, ctx, scope, "additionalFields.email");
  if (email) config.email = email;
  const description = kit.tpl(extra.description, ctx, scope, "additionalFields.description");
  if (description) config.description = description;
  const metadata = stripeMetadata(kit, ctx, scope, extra.metadata, "additionalFields.metadata");
  if (metadata) config.metadataJson = metadata;
  const dropped = Object.keys(extra).filter((key) => !["email", "description", "metadata"].includes(key));
  const reasons = [dropped.length ? `Customer fields (${dropped.join(", ")}) are not supported and were dropped.` : undefined];
  return finish(kit, kit.baseNode(source, scope, "stripe_create_customer", config), reasons);
};

const stripeChargeCreate: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const extra = kit.toRecord(params.additionalFields);
  const reasons: Array<string | undefined> = [];
  const config: Record<string, unknown> = {
    secretRef: stripeSecret(source, ctx, scope, kit),
    amount: typeof params.amount === "string" && params.amount.startsWith("=") ? kit.tpl(params.amount, ctx, scope, "amount") : kit.asNumber(params.amount, 0),
    currency: kit.tpl(params.currency, ctx, scope, "currency")
  };
  if (config.amount === 0) reasons.push("No amount was set; fill in amount after import.");
  if (!config.currency) reasons.push("No currency was set; fill in currency after import.");
  const customerId = kit.tpl(params.customerId, ctx, scope, "customerId");
  if (customerId) config.customerId = customerId;
  const description = kit.tpl(extra.description, ctx, scope, "additionalFields.description");
  if (description) config.description = description;
  const metadata = stripeMetadata(kit, ctx, scope, extra.metadata, "additionalFields.metadata");
  if (metadata) config.metadataJson = metadata;
  if (kit.asString(params.source).trim()) reasons.push("The payment source is not supported; the charge uses the customer's default source.");
  const dropped = Object.keys(extra).filter((key) => !["description", "metadata"].includes(key));
  if (dropped.length) reasons.push(`Charge fields (${dropped.join(", ")}) are not supported and were dropped.`);
  return finish(kit, kit.baseNode(source, scope, "stripe_create_charge", config), reasons);
};

function stripeTrigger(kit: AppKit): AppRegistration["handler"] {
  return (source, ctx, scope) => {
    const config: Record<string, unknown> = {
      path: kit.slugifyNodeId(source.name),
      signingSecretRef: kit.appSecret(source, ctx, scope, "stripeApi", "Stripe webhook signing secret"),
      replayToleranceSeconds: 300
    };
    const reasons = [
      eventFilterReason(kit, source.parameters.events),
      "Create the webhook endpoint in the Stripe dashboard and point it at the imported webhook path."
    ];
    return finish(kit, kit.baseNode(source, scope, "stripe_webhook_trigger", config), reasons);
  };
}

// --- Registrations -----------------------------------------------------------

export function crmPaymentsAppRegistrations(kit: AppKit): AppRegistration[] {
  return [
    {
      sourceType: `${BASE}hubspot`,
      targetType: "hubspot_create_contact",
      notes: "Contact create-or-update becomes a create and contact get maps directly; other resources and operations become placeholders.",
      handler: dispatchOperations(
        kit,
        "HubSpot",
        { resource: "contact", operation: "upsert" },
        { "contact/upsert": hubspotContactUpsert, "contact/get": hubspotContactGet }
      )
    },
    {
      sourceType: `${BASE}salesforce`,
      targetType: "salesforce_create_record",
      notes: "Record creation and SOQL search map; list operations become SOQL; the instance URL lives in the credential; other operations become placeholders.",
      handler: dispatchOperations(kit, "Salesforce", { resource: "lead", operation: "create" }, salesforceOperations())
    },
    {
      sourceType: `${BASE}stripe`,
      targetType: "stripe_create_customer",
      notes: "Customer and charge creation map with metadata; addresses, shipping and payment sources are dropped; other resources and operations become placeholders.",
      handler: dispatchOperations(
        kit,
        "Stripe",
        { resource: "balance", operation: "get" },
        { "customer/create": stripeCustomerCreate, "charge/create": stripeChargeCreate }
      )
    },
    {
      sourceType: `${BASE}stripeTrigger`,
      targetType: "stripe_webhook_trigger",
      notes: "Event filters are not supported; the signing secret becomes a placeholder.",
      handler: stripeTrigger(kit)
    }
  ];
}
