/**
 * App handlers: data stores (Google Sheets, Postgres, Airtable, AWS S3).
 */
import type { ConversionContext, ExpressionScope, SourceNode } from "../handler-types.js";
import {
  dispatchOperations,
  finish,
  jsonTemplate,
  readLocator,
  resolveLocatorId,
  translatedList,
  type AppKit,
  type AppRegistration,
  type Locator,
  type OperationHandler
} from "./kit.js";

const BASE = "n8n-nodes-base.";

// --- Google Sheets ----------------------------------------------------------

const SHEETS_DOCUMENT_URL = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;

function sheetsCredentialType(source: SourceNode): string {
  if ("googleApi" in source.credentials) return "googleApi";
  if ("googleSheetsTriggerOAuth2Api" in source.credentials) return "googleSheetsTriggerOAuth2Api";
  return "googleSheetsOAuth2Api";
}

interface SheetTarget {
  spreadsheetId: string;
  /** Sheet title usable in A1 notation, or empty when only a gid is known. */
  sheet: string;
  reasons: Array<string | undefined>;
}

/** Reads the spreadsheet id and the sheet title; sheets picked by gid fall back to the cached title. */
function sheetTarget(kit: AppKit, ctx: ConversionContext, scope: ExpressionScope, params: Record<string, unknown>): SheetTarget {
  const document = resolveLocatorId(kit, ctx, scope, params.documentId, "spreadsheet", "documentId", SHEETS_DOCUMENT_URL);
  const locator: Locator = readLocator(kit, params.sheetName);
  const reasons: Array<string | undefined> = [document.reason];
  let sheet = "";
  if (locator.value.startsWith("=")) {
    sheet = kit.tpl(locator.value, ctx, scope, "sheetName");
  } else if (locator.mode === "name" || locator.mode === "") {
    sheet = locator.value;
  } else if (locator.cachedName) {
    sheet = locator.cachedName;
  } else {
    reasons.push(`The sheet is referenced by its gid (${locator.value || "unknown"}), which cannot be used in a range; set range to '<sheet title>!A:Z' after import.`);
  }
  return { spreadsheetId: document.id, sheet, reasons };
}

function sheetRange(sheet: string, cells: string): string {
  if (!sheet) return cells;
  const quoted = /[^A-Za-z0-9_]/.test(sheet) ? `'${sheet.replace(/'/g, "''")}'` : sheet;
  return cells ? `${quoted}!${cells}` : quoted;
}

function sheetsBase(
  source: SourceNode,
  ctx: ConversionContext,
  scope: ExpressionScope,
  kit: AppKit,
  target: SheetTarget,
  cells: string,
  withAuthType: boolean
): Record<string, unknown> {
  return {
    spreadsheetId: target.spreadsheetId,
    range: sheetRange(target.sheet, cells),
    // The read and trigger nodes select the auth style; the write nodes always use a bearer token.
    ...(withAuthType ? { authType: "accessToken" } : {}),
    secretRef: kit.appSecret(source, ctx, scope, sheetsCredentialType(source), "Google Sheets access token")
  };
}

const sheetsRead: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const target = sheetTarget(kit, ctx, scope, params);
  const options = kit.toRecord(params.options);
  const config = sheetsBase(source, ctx, scope, kit, target, kit.asString(options.range).trim() || "A:Z", true);
  const reasons = [...target.reasons];
  if (kit.toArray(kit.toRecord(params.filtersUI).values).length) {
    reasons.push("Row filters are not supported; every row in the range is returned, so filter downstream.");
  }
  const dropped = Object.keys(options).filter((key) => key !== "range");
  if (dropped.length) reasons.push(`Read options (${dropped.join(", ")}) are not supported and were dropped.`);
  return finish(kit, kit.baseNode(source, scope, "google_sheets_read", config), reasons);
};

interface SheetValues {
  values: string[][];
  reasons: Array<string | undefined>;
}

/** Turns the column mapping into one row of cell values, in the order the columns were listed. */
function sheetValues(kit: AppKit, ctx: ConversionContext, scope: ExpressionScope, params: Record<string, unknown>): SheetValues {
  const columns = kit.toRecord(params.columns);
  const mappingMode = kit.asString(columns.mappingMode ?? params.dataMode, "defineBelow");
  if (mappingMode === "autoMapInputData") {
    return { values: [], reasons: ["Auto-mapping input items to columns is not supported; set values after import."] };
  }
  const defined = kit.toRecord(columns.value);
  const fieldRows = kit.toArray(kit.toRecord(params.fieldsUi).values);
  const cells = Object.keys(defined).length
    ? translatedList(kit, ctx, scope, "columns.value", Object.values(defined))
    : fieldRows.map((entry, index) => kit.tpl(kit.toRecord(entry).fieldValue, ctx, scope, `fieldsUi.values[${index}].fieldValue`));
  const names = Object.keys(defined).length ? Object.keys(defined) : fieldRows.map((entry) => kit.asString(kit.toRecord(entry).column));
  return {
    values: cells.length ? [cells] : [],
    reasons: [cells.length ? `Cells are written in the listed column order (${names.join(", ")}); matching on header names is not supported.` : "No columns were defined; set values after import."]
  };
}

function sheetsWrite(targetType: "google_sheets_append" | "google_sheets_update", extraReason?: string): OperationHandler {
  return (source, ctx, scope, kit) => {
    const params = source.parameters;
    const target = sheetTarget(kit, ctx, scope, params);
    const options = kit.toRecord(params.options);
    const values = sheetValues(kit, ctx, scope, params);
    const config = sheetsBase(source, ctx, scope, kit, target, targetType === "google_sheets_update" ? "A2" : "", false);
    config.values = values.values;
    config.valueInputOption = kit.asString(options.cellFormat) === "RAW" ? "RAW" : "USER_ENTERED";
    const reasons = [...target.reasons, ...values.reasons, extraReason];
    const matching = kit.toArray(kit.toRecord(params.columns).matchingColumns).map(String).filter(Boolean);
    if (matching.length) reasons.push(`Matching rows on (${matching.join(", ")}) is not supported.`);
    if (targetType === "google_sheets_update") reasons.push("The range was set to the first data row; point it at the rows to update after import.");
    const dropped = Object.keys(options).filter((key) => key !== "cellFormat");
    if (dropped.length) reasons.push(`Write options (${dropped.join(", ")}) are not supported and were dropped.`);
    return finish(kit, kit.baseNode(source, scope, targetType, config), reasons);
  };
}

function sheetsTrigger(kit: AppKit): AppRegistration["handler"] {
  return (source, ctx, scope) => {
    const params = source.parameters;
    const target = sheetTarget(kit, ctx, scope, params);
    const config = sheetsBase(source, ctx, scope, kit, target, "A:Z", true);
    config.pollIntervalSeconds = pollIntervalSeconds(kit, params.pollTimes);
    const reasons = [...target.reasons];
    const event = kit.asString(params.event, "rowAdded");
    if (event !== "rowAdded") reasons.push(`Only new rows are detected; the '${event}' event was approximated as a poll for new rows.`);
    return finish(kit, kit.baseNode(source, scope, "google_sheets_trigger", config), reasons);
  };
}

/** Poll-times → seconds, matching the RSS trigger conversion. */
function pollIntervalSeconds(kit: AppKit, raw: unknown): number {
  const item = kit.toRecord(kit.toArray(kit.toRecord(raw).item)[0]);
  const mode = kit.asString(item.mode, "everyMinute");
  if (mode === "everyHour") return 3600;
  if (mode === "everyX") {
    const value = Math.max(1, Math.floor(kit.asNumber(item.value, 5)));
    return kit.asString(item.unit, "minutes") === "hours" ? value * 3600 : value * 60;
  }
  return 60;
}

// --- Postgres ---------------------------------------------------------------

const POSTGRES_CREDENTIAL_REASON = "Host, port, database and user live in the source credential and must be filled in after import.";
const POSTGRES_WHERE_OPERATORS: Record<string, string> = {
  equal: "=",
  notEqual: "!=",
  like: "LIKE",
  greater: ">",
  less: "<",
  greaterEqual: ">=",
  lessEqual: "<=",
  isNull: "IS NULL",
  isNotNull: "IS NOT NULL"
};

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function postgresBase(source: SourceNode, ctx: ConversionContext, scope: ExpressionScope, kit: AppKit): Record<string, unknown> {
  return {
    host: "",
    port: 5432,
    database: "",
    user: "",
    ssl: false,
    secretRef: kit.appSecret(source, ctx, scope, "postgres", "Postgres password")
  };
}

function postgresTableName(kit: AppKit, params: Record<string, unknown>, tableKey: string): string {
  const schema = readLocator(kit, params.schema).value || "public";
  const table = readLocator(kit, params[tableKey]).value;
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

const postgresExecuteQuery: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const options = kit.toRecord(params.options);
  const config = postgresBase(source, ctx, scope, kit);
  config.query = kit.tpl(params.query, ctx, scope, "query");
  const replacement = options.queryReplacement;
  const values = Array.isArray(replacement)
    ? translatedList(kit, ctx, scope, "options.queryReplacement", replacement)
    : kit.asString(replacement).trim()
      ? kit.asString(replacement).split(",").map((value, index) => kit.tpl(value.trim(), ctx, scope, `options.queryReplacement[${index}]`))
      : [];
  if (values.length) config.params = values;
  const reasons = [POSTGRES_CREDENTIAL_REASON];
  const dropped = Object.keys(options).filter((key) => key !== "queryReplacement");
  if (dropped.length) reasons.push(`Query options (${dropped.join(", ")}) are not supported and were dropped.`);
  return finish(kit, kit.baseNode(source, scope, "postgres_query", config), reasons);
};

const postgresSelect: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const config = postgresBase(source, ctx, scope, kit);
  const reasons: Array<string | undefined> = [POSTGRES_CREDENTIAL_REASON];
  const clauses: string[] = [];
  const values: string[] = [];
  const dropped: string[] = [];
  kit.toArray(kit.toRecord(params.where).values).forEach((entry, index) => {
    const condition = kit.toRecord(entry);
    const column = kit.asString(condition.column).trim();
    const operator = POSTGRES_WHERE_OPERATORS[kit.asString(condition.condition, "equal")];
    if (!column || !operator) {
      dropped.push(column || `#${index + 1}`);
      return;
    }
    if (operator.startsWith("IS")) {
      clauses.push(`${quoteIdentifier(column)} ${operator}`);
      return;
    }
    values.push(kit.tpl(condition.value, ctx, scope, `where.values[${index}].value`));
    clauses.push(`${quoteIdentifier(column)} ${operator} $${values.length}`);
  });
  const sorts = kit
    .toArray(kit.toRecord(params.sort).values)
    .map((entry) => {
      const sort = kit.toRecord(entry);
      const column = kit.asString(sort.column).trim();
      return column ? `${quoteIdentifier(column)} ${kit.asString(sort.direction, "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC"}` : "";
    })
    .filter(Boolean);
  let query = `SELECT * FROM ${postgresTableName(kit, params, "table")}`;
  if (clauses.length) query += ` WHERE ${clauses.join(` ${kit.asString(params.combineConditions, "AND").toUpperCase() === "OR" ? "OR" : "AND"} `)}`;
  if (sorts.length) query += ` ORDER BY ${sorts.join(", ")}`;
  if (params.returnAll !== true) query += ` LIMIT ${Math.max(1, Math.floor(kit.asNumber(params.limit, 50)))}`;
  config.query = query;
  if (values.length) config.params = values;
  if (dropped.length) reasons.push(`Where conditions (${dropped.join(", ")}) use operators that could not be translated and were dropped.`);
  reasons.push("The select was rewritten as a SQL query; review it after import.");
  return finish(kit, kit.baseNode(source, scope, "postgres_query", config), reasons);
};

function postgresTrigger(kit: AppKit): AppRegistration["handler"] {
  return (source, ctx, scope) => {
    const params = source.parameters;
    const config = postgresBase(source, ctx, scope, kit);
    config.query = `SELECT * FROM ${postgresTableName(kit, params, "tableName")}`;
    config.pollIntervalSeconds = 60;
    const mode = kit.asString(params.triggerMode, "createTrigger");
    const firesOn = kit.asString(params.firesOn, "INSERT");
    const reasons = [
      POSTGRES_CREDENTIAL_REASON,
      mode === "listenTrigger"
        ? `LISTEN on channel '${kit.asString(params.channelName)}' is approximated as a polling query; add a watermark condition to the query after import.`
        : `The '${firesOn}' table trigger is approximated as a polling query every minute; add a watermark condition to the query after import.`
    ];
    return finish(kit, kit.baseNode(source, scope, "postgres_trigger", config), reasons);
  };
}

// --- Airtable ---------------------------------------------------------------

const AIRTABLE_BASE_URL = /(app[A-Za-z0-9]{14})/;
const AIRTABLE_TABLE_URL = /(tbl[A-Za-z0-9]{14})/;
const AIRTABLE_VIEW_URL = /(viw[A-Za-z0-9]{14})/;

function airtableCredentialType(source: SourceNode): string {
  if ("airtableOAuth2Api" in source.credentials) return "airtableOAuth2Api";
  if ("airtableApi" in source.credentials) return "airtableApi";
  return "airtableTokenApi";
}

function airtableBase(source: SourceNode, ctx: ConversionContext, scope: ExpressionScope, kit: AppKit): { config: Record<string, unknown>; reasons: Array<string | undefined> } {
  const params = source.parameters;
  const base = resolveLocatorId(kit, ctx, scope, params.base ?? params.application, "Airtable base", "base", AIRTABLE_BASE_URL);
  const table = resolveLocatorId(kit, ctx, scope, params.table, "Airtable table", "table", AIRTABLE_TABLE_URL);
  return {
    config: {
      secretRef: kit.appSecret(source, ctx, scope, airtableCredentialType(source), "Airtable personal access token"),
      baseId: base.id,
      table: table.id
    },
    reasons: [base.reason, table.reason]
  };
}

interface AirtableFields {
  fieldsJson?: string;
  reason?: string;
}

function airtableFields(kit: AppKit, ctx: ConversionContext, scope: ExpressionScope, params: Record<string, unknown>, exclude: string[] = []): AirtableFields {
  const columns = kit.toRecord(params.columns);
  if (kit.asString(columns.mappingMode, "defineBelow") === "autoMapInputData") {
    return { reason: "Auto-mapping input items to fields is not supported; set fieldsJson after import." };
  }
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(kit.toRecord(columns.value))) {
    if (!exclude.includes(key)) fields[key] = value;
  }
  if (!Object.keys(fields).length) return { reason: "No fields were defined; set fieldsJson after import." };
  return { fieldsJson: jsonTemplate(kit, ctx, scope, "columns.value", fields) };
}

const airtableCreate: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const { config, reasons } = airtableBase(source, ctx, scope, kit);
  const fields = airtableFields(kit, ctx, scope, params);
  if (fields.fieldsJson) config.fieldsJson = fields.fieldsJson;
  if (kit.toRecord(params.options).typecast === true) config.typecast = true;
  reasons.push(fields.reason);
  return finish(kit, kit.baseNode(source, scope, "airtable_create_record", config), reasons);
};

const airtableUpdate: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const { config, reasons } = airtableBase(source, ctx, scope, kit);
  const columns = kit.toRecord(params.columns);
  const recordId = kit.asString(kit.toRecord(columns.value).id ?? params.id).trim();
  config.recordId = kit.tpl(recordId, ctx, scope, "columns.value.id");
  if (!recordId) reasons.push("No record id was set; fill in recordId after import.");
  const fields = airtableFields(kit, ctx, scope, params, ["id"]);
  if (fields.fieldsJson) config.fieldsJson = fields.fieldsJson;
  reasons.push(fields.reason);
  if (kit.toRecord(params.options).typecast === true) reasons.push("Typecasting on update is not supported and was dropped.");
  return finish(kit, kit.baseNode(source, scope, "airtable_update_record", config), reasons);
};

const airtableSearch: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const { config, reasons } = airtableBase(source, ctx, scope, kit);
  const options = kit.toRecord(params.options);
  const formula = kit.asString(params.filterByFormula).trim();
  if (formula) config.filterByFormula = kit.tpl(formula, ctx, scope, "filterByFormula");
  config.maxRecords = params.returnAll === true ? 100 : Math.max(1, Math.floor(kit.asNumber(params.limit, 100)));
  if (params.returnAll === true) reasons.push("Returning all records is not supported; the first 100 are returned.");
  const view = resolveLocatorId(kit, ctx, scope, options.view, "Airtable view", "options.view", AIRTABLE_VIEW_URL);
  if (view.id) {
    config.view = view.id;
    reasons.push(view.reason);
  }
  const dropped = Object.keys(options).filter((key) => key !== "view");
  if (dropped.length) reasons.push(`Search options (${dropped.join(", ")}) are not supported and were dropped.`);
  return finish(kit, kit.baseNode(source, scope, "airtable_list_records", config), reasons);
};

// --- AWS S3 -----------------------------------------------------------------

const S3_REGION_REASON =
  "The region lives in the source credential; defaulted to us-east-1, change region after import if needed. The AWS secret must hold JSON with accessKeyId and secretAccessKey.";

function s3Base(source: SourceNode, ctx: ConversionContext, scope: ExpressionScope, kit: AppKit): Record<string, unknown> {
  return {
    region: "us-east-1",
    bucket: kit.tpl(source.parameters.bucketName, ctx, scope, "bucketName"),
    secretRef: kit.appSecret(source, ctx, scope, "aws", "AWS access key pair")
  };
}

const s3FileDownload: OperationHandler = (source, ctx, scope, kit) => {
  const config = s3Base(source, ctx, scope, kit);
  config.key = kit.tpl(source.parameters.fileKey, ctx, scope, "fileKey");
  return finish(kit, kit.baseNode(source, scope, "aws_s3_get_object", config), [S3_REGION_REASON]);
};

const s3FileUpload: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const config = s3Base(source, ctx, scope, kit);
  const reasons: Array<string | undefined> = [S3_REGION_REASON];
  const folder = kit.asString(kit.toRecord(params.additionalFields).parentFolderKey).trim();
  const fileName = kit.tpl(params.fileName, ctx, scope, "fileName");
  config.key = folder ? `${folder.replace(/\/+$/, "")}/${fileName}` : fileName;
  if (params.binaryData === false) {
    config.body = kit.tpl(params.fileContent, ctx, scope, "fileContent");
    config.contentType = "text/plain";
  } else {
    config.body = "";
    reasons.push("Binary uploads are not supported; set body (and contentType) to the text to upload after import.");
  }
  const dropped = Object.keys(kit.toRecord(params.additionalFields)).filter((key) => key !== "parentFolderKey");
  if (dropped.length) reasons.push(`Upload options (${dropped.join(", ")}) are not supported and were dropped.`);
  return finish(kit, kit.baseNode(source, scope, "aws_s3_put_object", config), reasons);
};

const s3FileGetAll: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const options = kit.toRecord(params.options);
  const config = s3Base(source, ctx, scope, kit);
  const reasons: Array<string | undefined> = [S3_REGION_REASON];
  const prefix = kit.asString(options.folderKey).trim();
  if (prefix) config.prefix = kit.tpl(prefix, ctx, scope, "options.folderKey");
  config.maxKeys = params.returnAll === true ? 1000 : Math.max(1, Math.floor(kit.asNumber(params.limit, 100)));
  if (params.returnAll === true) reasons.push("Returning all objects is not supported; the first 1000 keys are listed.");
  const dropped = Object.keys(options).filter((key) => key !== "folderKey");
  if (dropped.length) reasons.push(`List options (${dropped.join(", ")}) are not supported and were dropped.`);
  return finish(kit, kit.baseNode(source, scope, "aws_s3_list_objects", config), reasons);
};

// --- Registrations -----------------------------------------------------------

export function dataAppRegistrations(kit: AppKit): AppRegistration[] {
  return [
    {
      sourceType: `${BASE}googleSheets`,
      targetType: "google_sheets_read",
      notes: "Read, append, append-or-update and update map to the Sheets nodes; row filters and header matching are dropped; sheets picked by gid need the range set; other operations become placeholders.",
      handler: dispatchOperations(
        kit,
        "Google Sheets",
        { resource: "sheet", operation: "read" },
        {
          "sheet/read": sheetsRead,
          "sheet/append": sheetsWrite("google_sheets_append"),
          "sheet/appendOrUpdate": sheetsWrite("google_sheets_append", "Append-or-update became a plain append; existing rows are not updated."),
          "sheet/update": sheetsWrite("google_sheets_update")
        }
      )
    },
    {
      sourceType: `${BASE}googleSheetsTrigger`,
      targetType: "google_sheets_trigger",
      notes: "Polls the sheet for new rows; row-update events are approximated.",
      handler: sheetsTrigger(kit)
    },
    {
      sourceType: `${BASE}postgres`,
      targetType: "postgres_query",
      notes: "Execute-query and select map to a query; the connection details live in the credential; insert, update, upsert and delete become placeholders.",
      handler: dispatchOperations(
        kit,
        "Postgres",
        { resource: "database", operation: "insert" },
        { "database/executeQuery": postgresExecuteQuery, "database/select": postgresSelect }
      )
    },
    {
      sourceType: `${BASE}postgresTrigger`,
      targetType: "postgres_trigger",
      notes: "Table and LISTEN triggers are approximated as a polling query.",
      handler: postgresTrigger(kit)
    },
    {
      sourceType: `${BASE}airtable`,
      targetType: "airtable_list_records",
      notes: "Search, create and update map to the Airtable nodes; auto-mapped fields are dropped; get, upsert and delete become placeholders.",
      handler: dispatchOperations(
        kit,
        "Airtable",
        { resource: "record", operation: "get" },
        { "record/search": airtableSearch, "record/create": airtableCreate, "record/update": airtableUpdate }
      )
    },
    {
      sourceType: `${BASE}awsS3`,
      targetType: "aws_s3_get_object",
      notes: "File download, upload and listing map to the S3 nodes; the region lives in the credential; binary uploads need the body set; bucket and folder operations become placeholders.",
      handler: dispatchOperations(
        kit,
        "AWS S3",
        { resource: "file", operation: "download" },
        { "file/download": s3FileDownload, "file/upload": s3FileUpload, "file/getAll": s3FileGetAll }
      )
    }
  ];
}
