/**
 * Dispatcher for Phase 2 transformation nodes.
 * Pulled into its own module to keep executor.ts manageable.
 */
import type { WorkflowNode } from "@ai-orchestrator/shared";
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";
import { renderTemplate } from "./template";
import {
  aggregateItems,
  compareDatasets,
  compressionGunzip,
  compressionGzip,
  editFields,
  ensureArray,
  fromCsv,
  htmlExtract,
  jsonToXml,
  jwtDecode,
  jwtSign,
  jwtVerify,
  limitItems,
  performCrypto,
  performDateTime,
  removeDuplicates,
  renameKeys,
  sortItems,
  splitOut,
  summarizeItems,
  toCsv,
  xmlToJson,
  type AggregateOp,
  type CryptoOp,
  type DateTimeOp,
  type DateUnit,
  type EditOp,
  type HtmlSelectorSpec,
  type JwtAlgorithm,
  type SortOrder,
  type SummarizeField
} from "./transformations";

export interface Phase2Context {
  templateData: Record<string, unknown>;
  parentOutputs: Record<string, unknown>;
  getValueByPath: (input: Record<string, unknown>, path: string) => unknown;
}

function getStringConfig(config: Record<string, unknown>, key: string, fallback = ""): string {
  const v = config[key];
  return typeof v === "string" ? v : fallback;
}

function resolveItemsInput(
  config: Record<string, unknown>,
  ctx: Phase2Context
): unknown[] {
  const explicitKey = typeof config.inputKey === "string" && config.inputKey.trim() ? config.inputKey.trim() : "";
  if (explicitKey) {
    const value = ctx.templateData[explicitKey] ?? ctx.getValueByPath(ctx.templateData, explicitKey);
    return ensureArray(value);
  }
  if ("data" in config && config.data !== undefined) return ensureArray(config.data);
  for (const candidate of ["items", "rows", "documents"]) {
    const v = ctx.templateData[candidate];
    if (v !== undefined) return ensureArray(v);
  }
  const parents = Object.values(ctx.parentOutputs);
  if (parents.length === 1 && Array.isArray(parents[0])) return parents[0] as unknown[];
  return [];
}

export function executePhase2Node(
  node: WorkflowNode,
  config: Record<string, unknown>,
  ctx: Phase2Context
): unknown {
  try {
    switch (node.type) {
      case "aggregate_node": {
        const operation = getStringConfig(config, "operation") as AggregateOp;
        if (!operation) throw new WorkflowError("aggregate_node requires operation", ErrorCategory.NODE_CONFIG, false);
        const items = resolveItemsInput(config, ctx);
        const field = getStringConfig(config, "field") || undefined;
        const groupBy = getStringConfig(config, "groupBy") || undefined;
        const separator = getStringConfig(config, "separator", ",");
        const result = aggregateItems(items, operation, field, { groupBy, separator });
        return { ...result, items };
      }
      case "split_out_node": {
        const field = getStringConfig(config, "field");
        if (!field) throw new WorkflowError("split_out_node requires field", ErrorCategory.NODE_CONFIG, false);
        const items = resolveItemsInput(config, ctx);
        const destinationField = getStringConfig(config, "destinationField") || undefined;
        const out = splitOut(items, field, destinationField);
        return { items: out, count: out.length };
      }
      case "sort_node": {
        const items = resolveItemsInput(config, ctx);
        const order = (getStringConfig(config, "order") || "asc") as SortOrder;
        const field = getStringConfig(config, "field") || undefined;
        const expression = getStringConfig(config, "expression") || undefined;
        const out = sortItems(items, { field, order, expression });
        return { items: out, count: out.length };
      }
      case "limit_node": {
        const items = resolveItemsInput(config, ctx);
        const maxItems = typeof config.maxItems === "number" ? config.maxItems : Number(config.maxItems);
        if (!Number.isFinite(maxItems)) {
          throw new WorkflowError("limit_node requires numeric maxItems", ErrorCategory.NODE_CONFIG, false);
        }
        const keep = (getStringConfig(config, "keep") || "first") as "first" | "last";
        const out = limitItems(items, maxItems, keep);
        return { items: out, count: out.length };
      }
      case "remove_duplicates_node": {
        const items = resolveItemsInput(config, ctx);
        const fields = Array.isArray(config.fields) ? (config.fields as string[]) : undefined;
        const out = removeDuplicates(items, fields);
        return { items: out, count: out.length };
      }
      case "summarize_node": {
        const items = resolveItemsInput(config, ctx);
        const fieldsToSummarize = Array.isArray(config.fieldsToSummarize)
          ? (config.fieldsToSummarize as SummarizeField[])
          : [];
        const fieldsToGroupBy = Array.isArray(config.fieldsToGroupBy)
          ? (config.fieldsToGroupBy as string[])
          : undefined;
        const out = summarizeItems(items, fieldsToSummarize, fieldsToGroupBy);
        return { items: out, count: out.length };
      }
      case "compare_datasets_node": {
        const inputA = getStringConfig(config, "inputA");
        const inputB = getStringConfig(config, "inputB");
        const keyField = getStringConfig(config, "keyField");
        if (!inputA || !inputB || !keyField) {
          throw new WorkflowError(
            "compare_datasets_node requires inputA, inputB, keyField",
            ErrorCategory.NODE_CONFIG,
            false
          );
        }
        const a = ensureArray(ctx.templateData[inputA] ?? ctx.getValueByPath(ctx.templateData, inputA));
        const b = ensureArray(ctx.templateData[inputB] ?? ctx.getValueByPath(ctx.templateData, inputB));
        return compareDatasets(a, b, keyField);
      }
      case "rename_keys_node": {
        const renames = Array.isArray(config.renames)
          ? (config.renames as Array<{ from: string; to: string }>)
          : [];
        const items = resolveItemsInput(config, ctx);
        const out = renameKeys(items, renames);
        return { items: out, count: out.length };
      }
      case "edit_fields_node": {
        const operations = Array.isArray(config.operations) ? (config.operations as EditOp[]) : [];
        const items = resolveItemsInput(config, ctx);
        const out = editFields(items, operations);
        return { items: out, count: out.length };
      }
      case "date_time_node": {
        const operation = getStringConfig(config, "operation") as DateTimeOp;
        if (!operation) throw new WorkflowError("date_time_node requires operation", ErrorCategory.NODE_CONFIG, false);
        const value = getStringConfig(config, "value") || undefined;
        const format = getStringConfig(config, "format") || undefined;
        const unit = (getStringConfig(config, "unit") || "ms") as DateUnit;
        const amount = typeof config.amount === "number" ? config.amount : Number(config.amount ?? 0);
        const compareTo = getStringConfig(config, "compareTo") || undefined;
        const timezone = getStringConfig(config, "timezone") || undefined;
        const result = performDateTime({ operation, value, format, unit, amount, compareTo, timezone });
        return { result, value: result };
      }
      case "crypto_node": {
        const operation = getStringConfig(config, "operation") as CryptoOp;
        if (!operation) throw new WorkflowError("crypto_node requires operation", ErrorCategory.NODE_CONFIG, false);
        const algorithm = getStringConfig(config, "algorithm") || "sha256";
        const key = getStringConfig(config, "key") || undefined;
        const iv = getStringConfig(config, "iv") || undefined;
        const data = getStringConfig(config, "data");
        const encoding = (getStringConfig(config, "encoding") || "hex") as "hex" | "base64" | "utf8";
        const signature = getStringConfig(config, "signature") || undefined;
        const bytes = typeof config.bytes === "number" ? config.bytes : 16;
        const result = performCrypto({ operation, algorithm, key, iv, data, encoding, signature, bytes });
        return { result, value: result };
      }
      case "jwt_node": {
        const operation = getStringConfig(config, "operation");
        const secret = getStringConfig(config, "secret");
        const algorithm = (getStringConfig(config, "algorithm") || "HS256") as JwtAlgorithm;
        if (operation === "sign") {
          const payload = (config.payload && typeof config.payload === "object" ? config.payload : {}) as Record<string, unknown>;
          const expiresInSeconds = typeof config.expiresInSeconds === "number" ? config.expiresInSeconds : undefined;
          const token = jwtSign(payload, secret, algorithm, expiresInSeconds);
          return { token };
        }
        if (operation === "decode") {
          return jwtDecode(getStringConfig(config, "token"));
        }
        if (operation === "verify") {
          return jwtVerify(getStringConfig(config, "token"), secret);
        }
        throw new WorkflowError(
          "jwt_node: unsupported operation " + String(operation),
          ErrorCategory.NODE_CONFIG,
          false
        );
      }
      case "xml_node": {
        const operation = getStringConfig(config, "operation");
        const data = config.data;
        if (operation === "toJson") {
          if (typeof data !== "string") {
            throw new WorkflowError("xml_node toJson requires string data", ErrorCategory.NODE_CONFIG, false);
          }
          return { result: xmlToJson(data) };
        }
        if (operation === "toXml") {
          return { result: jsonToXml(data) };
        }
        throw new WorkflowError(
          "xml_node: unsupported operation " + String(operation),
          ErrorCategory.NODE_CONFIG,
          false
        );
      }
      case "html_node": {
        const operation = getStringConfig(config, "operation");
        if (operation === "extract") {
          const html = getStringConfig(config, "html");
          const selectors = Array.isArray(config.selectors) ? (config.selectors as HtmlSelectorSpec[]) : [];
          return { result: htmlExtract(html, selectors) };
        }
        if (operation === "generate") {
          const template = getStringConfig(config, "template");
          const rendered = renderTemplate(template, ctx.templateData);
          return { result: rendered };
        }
        throw new WorkflowError(
          "html_node: unsupported operation " + String(operation),
          ErrorCategory.NODE_CONFIG,
          false
        );
      }
      case "convert_to_file_node": {
        const format = getStringConfig(config, "format");
        const filename = getStringConfig(config, "filename") || "output." + format;
        const items = resolveItemsInput(config, ctx);
        let content = "";
        let mimeType = "application/octet-stream";
        if (format === "csv") {
          content = toCsv(items);
          mimeType = "text/csv";
        } else if (format === "json") {
          content = JSON.stringify(items.length === 1 && config.inputKey ? items[0] : items, null, 2);
          mimeType = "application/json";
        } else if (format === "html") {
          const escaped = JSON.stringify(items, null, 2).replace(/</g, "&lt;");
          content = "<html><body><pre>" + escaped + "</pre></body></html>";
          mimeType = "text/html";
        } else if (format === "text") {
          content = items.map((it) => (typeof it === "string" ? it : JSON.stringify(it))).join("\n");
          mimeType = "text/plain";
        } else {
          throw new WorkflowError(
            "convert_to_file_node: unsupported format " + String(format),
            ErrorCategory.NODE_CONFIG,
            false
          );
        }
        return { filename, mimeType, content };
      }
      case "extract_from_file_node": {
        const format = getStringConfig(config, "format");
        const encoding = (getStringConfig(config, "encoding") || "utf8") as "utf8" | "base64";
        const raw =
          getStringConfig(config, "data") ||
          (typeof config.inputKey === "string" ? String(ctx.templateData[config.inputKey] ?? "") : "");
        const decoded = encoding === "base64" ? Buffer.from(raw, "base64").toString("utf8") : raw;
        if (format === "csv") return { rows: fromCsv(decoded) };
        if (format === "json") {
          try {
            return { data: JSON.parse(decoded) };
          } catch (e) {
            throw new WorkflowError(
              "extract_from_file_node: invalid JSON - " + (e as Error).message,
              ErrorCategory.PARSER_INVALID_JSON,
              false
            );
          }
        }
        if (format === "xml") return { data: xmlToJson(decoded) };
        if (format === "pdf" || format === "excel") {
          throw new WorkflowError(
            "extract_from_file_node: " + format + " parsing requires an optional dependency that is not installed in this build.",
            ErrorCategory.NOT_IMPLEMENTED,
            false
          );
        }
        throw new WorkflowError(
          "extract_from_file_node: unsupported format " + String(format),
          ErrorCategory.NODE_CONFIG,
          false
        );
      }
      case "compression_node": {
        const operation = getStringConfig(config, "operation");
        const data = getStringConfig(config, "data");
        const encoding = (getStringConfig(config, "encoding") || "utf8") as "utf8" | "base64";
        if (operation === "gzip") return { result: compressionGzip(data, encoding), encoding: "base64" };
        if (operation === "gunzip") return { result: compressionGunzip(data) };
        if (operation === "zip" || operation === "unzip") {
          throw new WorkflowError(
            "compression_node: " + operation + " is not supported in this build (use gzip/gunzip).",
            ErrorCategory.NOT_IMPLEMENTED,
            false
          );
        }
        throw new WorkflowError(
          "compression_node: unsupported operation " + String(operation),
          ErrorCategory.NODE_CONFIG,
          false
        );
      }
      case "edit_image_node": {
        throw new WorkflowError(
          "edit_image_node is not implemented in this build. Image editing requires an optional native dependency (e.g. sharp or jimp). Install it and provide a custom adapter.",
          ErrorCategory.NOT_IMPLEMENTED,
          false
        );
      }
      default:
        throw new WorkflowError(
          "Unsupported phase-2 node " + String(node.type),
          ErrorCategory.NODE_CONFIG,
          false
        );
    }
  } catch (err) {
    if (err instanceof WorkflowError) throw err;
    throw new WorkflowError(
      err instanceof Error ? err.message : String(err),
      ErrorCategory.UNKNOWN,
      false,
      { nodeId: node.id, nodeType: node.type }
    );
  }
}
