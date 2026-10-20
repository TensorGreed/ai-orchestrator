/**
 * App handlers: developer tools (GitHub, Jira, Notion).
 */
import type { ConversionContext, ExpressionScope, SourceNode } from "../handler-types.js";
import {
  dispatchOperations,
  eventFilterReason,
  finish,
  jsonTemplate,
  readLocator,
  resolveLocatorId,
  type AppKit,
  type AppRegistration,
  type OperationHandler
} from "./kit.js";

const BASE = "n8n-nodes-base.";

// --- GitHub -----------------------------------------------------------------

const GITHUB_OWNER_URL = /github\.com\/([^/?#]+)/;
const GITHUB_REPO_URL = /github\.com\/[^/?#]+\/([^/?#]+)/;

function githubCredentialType(source: SourceNode): string {
  return "githubOAuth2Api" in source.credentials ? "githubOAuth2Api" : "githubApi";
}

interface GithubTarget {
  config: Record<string, unknown>;
  reasons: Array<string | undefined>;
}

function githubTarget(source: SourceNode, ctx: ConversionContext, scope: ExpressionScope, kit: AppKit, operation: string): GithubTarget {
  const params = source.parameters;
  const owner = resolveLocatorId(kit, ctx, scope, params.owner, "GitHub owner", "owner", GITHUB_OWNER_URL);
  const repo = resolveLocatorId(kit, ctx, scope, params.repository, "GitHub repository", "repository", GITHUB_REPO_URL);
  return {
    config: {
      secretRef: kit.appSecret(source, ctx, scope, githubCredentialType(source), "GitHub personal access token"),
      owner: owner.id,
      repo: repo.id,
      operation
    },
    reasons: [owner.reason, repo.reason]
  };
}

function githubIssueNumber(kit: AppKit, ctx: ConversionContext, scope: ExpressionScope, raw: unknown): { value: number | string; reason?: string } {
  if (typeof raw === "string" && raw.startsWith("=")) return { value: kit.tpl(raw, ctx, scope, "issueNumber") };
  const value = kit.asNumber(raw, 0);
  return value > 0 ? { value } : { value: 0, reason: "No issue number was set; fill in issueNumber after import." };
}

const githubIssueCreate: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const { config, reasons } = githubTarget(source, ctx, scope, kit, "createIssue");
  config.title = kit.tpl(params.title, ctx, scope, "title");
  config.body = kit.tpl(params.body, ctx, scope, "body");
  const labels = kit.toArray(kit.toRecord(params.labels).labels ?? params.labels);
  const assignees = kit.toArray(kit.toRecord(params.assignees).assignees ?? params.assignees);
  if (labels.length) reasons.push("Issue labels are not supported and were dropped.");
  if (assignees.length) reasons.push("Issue assignees are not supported and were dropped.");
  return finish(kit, kit.baseNode(source, scope, "github_action", config), reasons);
};

const githubIssueComment: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const { config, reasons } = githubTarget(source, ctx, scope, kit, "commentIssue");
  const issue = githubIssueNumber(kit, ctx, scope, params.issueNumber);
  config.issueNumber = issue.value;
  config.body = kit.tpl(params.body, ctx, scope, "body");
  reasons.push(issue.reason);
  return finish(kit, kit.baseNode(source, scope, "github_action", config), reasons);
};

const githubIssueEdit: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const edits = kit.toRecord(params.editFields);
  if (kit.asString(edits.state) !== "closed") {
    return kit.unsupportedPlaceholder(
      source,
      scope,
      "GitHub resource 'issue' operation 'edit' is only supported when it closes the issue; imported as a disabled placeholder."
    );
  }
  const { config, reasons } = githubTarget(source, ctx, scope, kit, "closeIssue");
  const issue = githubIssueNumber(kit, ctx, scope, params.issueNumber);
  config.issueNumber = issue.value;
  reasons.push(issue.reason);
  const otherEdits = Object.keys(edits).filter((key) => key !== "state");
  if (otherEdits.length) reasons.push(`Issue edits other than closing (${otherEdits.join(", ")}) are not supported and were dropped.`);
  return finish(kit, kit.baseNode(source, scope, "github_action", config), reasons);
};

const githubFileGet: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const { config, reasons } = githubTarget(source, ctx, scope, kit, "getFile");
  config.path = kit.tpl(params.filePath, ctx, scope, "filePath");
  if (params.asBinaryProperty === true) reasons.push("Binary file output is not supported; the file is returned as the API's JSON content object.");
  return finish(kit, kit.baseNode(source, scope, "github_action", config), reasons);
};

const githubFileWrite: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  if (params.binaryData === true) {
    return kit.unsupportedPlaceholder(
      source,
      scope,
      "GitHub resource 'file' operations that write binary data have no L2M equivalent; imported as a disabled placeholder."
    );
  }
  const { config, reasons } = githubTarget(source, ctx, scope, kit, "createOrUpdateFile");
  config.path = kit.tpl(params.filePath, ctx, scope, "filePath");
  config.content = kit.tpl(params.fileContent, ctx, scope, "fileContent");
  config.commitMessage = kit.tpl(params.commitMessage, ctx, scope, "commitMessage");
  const branch = kit.asString(kit.toRecord(kit.toRecord(kit.toRecord(params.additionalParameters).branch)).branch).trim();
  if (branch) config.branch = kit.tpl(branch, ctx, scope, "additionalParameters.branch.branch");
  if (kit.asString(params.operation) === "edit") reasons.push("Editing a file needs the current blob sha at run time; set sha after import or let the first run fail with the sha to use.");
  return finish(kit, kit.baseNode(source, scope, "github_action", config), reasons);
};

const githubRepositoryIssues: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const { config, reasons } = githubTarget(source, ctx, scope, kit, "listIssues");
  const filters = Object.keys(kit.toRecord(params.getRepositoryIssuesFilters));
  if (filters.length) reasons.push(`Issue filters (${filters.join(", ")}) are not supported; only open issues are listed.`);
  if (params.returnAll !== true) reasons.push("Result limits are not supported; the first page of open issues is returned.");
  return finish(kit, kit.baseNode(source, scope, "github_action", config), reasons);
};

function githubTrigger(kit: AppKit): AppRegistration["handler"] {
  return (source, ctx, scope) => {
    const params = source.parameters;
    const config: Record<string, unknown> = {
      path: kit.slugifyNodeId(source.name),
      secretRef: kit.appSecret(source, ctx, scope, githubCredentialType(source), "GitHub webhook secret")
    };
    const owner = readLocator(kit, params.owner).value;
    const repo = readLocator(kit, params.repository).value;
    const reasons = [
      eventFilterReason(kit, params.events),
      owner && repo ? `Create the webhook on ${owner}/${repo} by hand and point it at the imported webhook path.` : "Point the repository webhook at the imported webhook path after import."
    ];
    return finish(kit, kit.baseNode(source, scope, "github_webhook_trigger", config), reasons);
  };
}

// --- Jira -------------------------------------------------------------------

const JIRA_CREDENTIAL_REASON = "The Jira site URL and account email live in the source credential; set baseUrl and email after import.";

function jiraCredentialType(source: SourceNode): string {
  return "jiraSoftwareServerApi" in source.credentials ? "jiraSoftwareServerApi" : "jiraSoftwareCloudApi";
}

function jiraBase(source: SourceNode, ctx: ConversionContext, scope: ExpressionScope, kit: AppKit): Record<string, unknown> {
  return {
    baseUrl: "",
    email: "",
    secretRef: kit.appSecret(source, ctx, scope, jiraCredentialType(source), "Jira API token")
  };
}

const jiraIssueCreate: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const reasons: Array<string | undefined> = [JIRA_CREDENTIAL_REASON];
  const project = readLocator(kit, params.project);
  const issueType = readLocator(kit, params.issueType);
  const config = jiraBase(source, ctx, scope, kit);
  config.projectKey = project.value.startsWith("=") ? kit.tpl(project.value, ctx, scope, "project") : project.value;
  config.issueType = issueType.cachedName || (issueType.value.startsWith("=") ? kit.tpl(issueType.value, ctx, scope, "issueType") : issueType.value);
  config.summary = kit.tpl(params.summary, ctx, scope, "summary");
  if (/^\d+$/.test(project.value)) {
    reasons.push(`The project is referenced by id (${project.value}${project.cachedName ? `, '${project.cachedName}'` : ""}); replace projectKey with the project key after import.`);
  }
  if (/^\d+$/.test(String(config.issueType))) reasons.push(`The issue type is referenced by id (${issueType.value}); replace issueType with its name after import.`);

  const extra = kit.toRecord(params.additionalFields);
  const description = kit.asString(extra.description);
  if (description) config.description = kit.tpl(description, ctx, scope, "additionalFields.description");
  const fields: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(extra)) {
    if (key === "description") continue;
    if (key === "labels") fields.labels = kit.toArray(value).map(String);
    else if (key === "priority") fields.priority = { id: kit.asString(value) };
    else if (key === "assignee") fields.assignee = { id: kit.asString(readLocator(kit, value).value) };
    else if (key === "reporter") fields.reporter = { id: kit.asString(readLocator(kit, value).value) };
    else if (key === "parentIssueKey") fields.parent = { key: kit.asString(value) };
    else if (typeof value === "string") fields[key] = value;
    else dropped.push(key);
  }
  if (Object.keys(fields).length) config.fieldsJson = jsonTemplate(kit, ctx, scope, "additionalFields", fields);
  if (dropped.length) reasons.push(`Additional fields (${dropped.join(", ")}) are not supported and were dropped.`);
  return finish(kit, kit.baseNode(source, scope, "jira_create_issue", config), reasons);
};

const jiraIssueGetAll: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const reasons: Array<string | undefined> = [JIRA_CREDENTIAL_REASON];
  const options = kit.toRecord(params.options);
  const config = jiraBase(source, ctx, scope, kit);
  const jql = kit.asString(options.jql).trim();
  config.jql = jql ? kit.tpl(jql, ctx, scope, "options.jql") : "ORDER BY created DESC";
  if (!jql) reasons.push("No JQL filter was set; every issue is returned (newest first).");
  config.maxResults = params.returnAll === true ? 100 : Math.max(1, Math.floor(kit.asNumber(params.limit, 50)));
  if (params.returnAll === true) reasons.push("Returning all results is not supported; the first 100 issues are returned.");
  const dropped = Object.keys(options).filter((key) => key !== "jql");
  if (dropped.length) reasons.push(`Search options (${dropped.join(", ")}) are not supported and were dropped.`);
  return finish(kit, kit.baseNode(source, scope, "jira_search_issues", config), reasons);
};

// --- Notion -----------------------------------------------------------------

const NOTION_DATABASE_URL = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?|$)/i;

interface NotionProperty {
  name: string;
  type: string;
  value: unknown;
}

/** Translates the source builder's `Name|type` property rows into Notion API property values. */
function notionProperty(kit: AppKit, ctx: ConversionContext, scope: ExpressionScope, row: Record<string, unknown>, index: number): NotionProperty | undefined {
  const [name, type] = kit.asString(row.key).split("|");
  if (!name || !type) return undefined;
  const path = `propertiesUi.propertyValues[${index}]`;
  const text = (key: string) => kit.tpl(row[key], ctx, scope, `${path}.${key}`);
  switch (type) {
    case "title":
      return { name, type, value: text("title") };
    case "rich_text":
      return { name, type, value: { rich_text: [{ type: "text", text: { content: text("textContent") } }] } };
    case "number":
      return { name, type, value: { number: typeof row.numberValue === "number" ? row.numberValue : kit.asNumber(row.numberValue, 0) } };
    case "checkbox":
      return { name, type, value: { checkbox: row.checkboxValue === true } };
    case "url":
      return { name, type, value: { url: text("urlValue") } };
    case "email":
      return { name, type, value: { email: text("emailValue") } };
    case "phone_number":
      return { name, type, value: { phone_number: text("phoneValue") } };
    case "select":
      return { name, type, value: { select: { name: text("selectValue") } } };
    case "status":
      return { name, type, value: { status: { name: text("statusValue") } } };
    case "multi_select":
      return { name, type, value: { multi_select: kit.toArray(row.multiSelectValue).map((entry) => ({ name: kit.asString(entry) })) } };
    case "date":
      return { name, type, value: { date: { start: text("date"), ...(row.dateEnd ? { end: text("dateEnd") } : {}) } } };
    default:
      return undefined;
  }
}

const notionDatabasePageCreate: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const reasons: Array<string | undefined> = [];
  const database = resolveLocatorId(kit, ctx, scope, params.databaseId, "Notion database", "databaseId", NOTION_DATABASE_URL);
  reasons.push(database.reason);
  const config: Record<string, unknown> = {
    secretRef: kit.appSecret(source, ctx, scope, "notionApi", "Notion integration token"),
    databaseId: database.id
  };

  const properties: Record<string, unknown> = {};
  const dropped: string[] = [];
  kit.toArray(kit.toRecord(params.propertiesUi).propertyValues).forEach((entry, index) => {
    const row = kit.toRecord(entry);
    const property = notionProperty(kit, ctx, scope, row, index);
    if (!property) {
      dropped.push(kit.asString(row.key) || `#${index + 1}`);
      return;
    }
    if (property.type === "title") {
      config.titleProperty = property.name;
      config.title = property.value;
    } else {
      properties[property.name] = property.value;
    }
  });
  if (Object.keys(properties).length) config.propertiesJson = JSON.stringify(properties);
  if (dropped.length) reasons.push(`Properties of unsupported types (${dropped.join(", ")}) were dropped.`);

  const title = kit.asString(params.title).trim();
  if (title && !config.title) {
    config.title = kit.tpl(title, ctx, scope, "title");
  }
  if (kit.toArray(kit.toRecord(params.blockUi).blockValues).length) {
    reasons.push("Page content blocks are not supported; add contentMarkdown after import.");
  }
  return finish(kit, kit.baseNode(source, scope, "notion_create_page", config), reasons);
};

const notionDatabasePageGetAll: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const reasons: Array<string | undefined> = [];
  const database = resolveLocatorId(kit, ctx, scope, params.databaseId, "Notion database", "databaseId", NOTION_DATABASE_URL);
  reasons.push(database.reason);
  const config: Record<string, unknown> = {
    secretRef: kit.appSecret(source, ctx, scope, "notionApi", "Notion integration token"),
    databaseId: database.id,
    pageSize: params.returnAll === true ? 100 : Math.min(100, Math.max(1, Math.floor(kit.asNumber(params.limit, 50))))
  };
  if (params.returnAll === true) reasons.push("Returning all pages is not supported; the first 100 are returned.");

  const filterType = kit.asString(params.filterType, "none");
  if (filterType === "json") {
    config.filterJson = kit.tpl(params.filterJson, ctx, scope, "filterJson");
  } else if (filterType === "manual") {
    reasons.push("Manual filter conditions are not supported; rebuild them as filterJson after import.");
  }

  const sortValues = kit.toArray(kit.toRecord(kit.toRecord(kit.toRecord(params.options).sort)).sortValue);
  const sorts = sortValues
    .map((entry) => {
      const sort = kit.toRecord(entry);
      const direction = kit.asString(sort.direction, "ascending");
      if (kit.asString(sort.type, "property") === "timestamp") return { timestamp: kit.asString(sort.timestamp, "created_time"), direction };
      const [property] = kit.asString(sort.key).split("|");
      return property ? { property, direction } : undefined;
    })
    .filter(Boolean);
  if (sorts.length) config.sortsJson = JSON.stringify(sorts);
  return finish(kit, kit.baseNode(source, scope, "notion_query_database", config), reasons);
};

// --- Registrations -----------------------------------------------------------

export function devAppRegistrations(kit: AppKit): AppRegistration[] {
  return [
    {
      sourceType: `${BASE}github`,
      targetType: "github_action",
      notes: "Issue create/comment/close, file get/create/edit and repository issue listing map to github_action operations; labels, assignees and filters are dropped; other operations become placeholders.",
      handler: dispatchOperations(
        kit,
        "GitHub",
        { resource: "issue", operation: "create" },
        {
          "issue/create": githubIssueCreate,
          "issue/comment": githubIssueComment,
          "issue/edit": githubIssueEdit,
          "file/get": githubFileGet,
          "file/create": githubFileWrite,
          "file/edit": githubFileWrite,
          "repository/getIssues": githubRepositoryIssues
        }
      )
    },
    {
      sourceType: `${BASE}githubTrigger`,
      targetType: "github_webhook_trigger",
      notes: "Event filters are not supported; the webhook must be created on the repository by hand.",
      handler: githubTrigger(kit)
    },
    {
      sourceType: `${BASE}jira`,
      targetType: "jira_create_issue",
      notes: "Issue creation and JQL search map; the site URL and email live in the credential; other operations become placeholders.",
      handler: dispatchOperations(
        kit,
        "Jira",
        { resource: "issue", operation: "create" },
        { "issue/create": jiraIssueCreate, "issue/getAll": jiraIssueGetAll }
      )
    },
    {
      sourceType: `${BASE}notion`,
      targetType: "notion_create_page",
      notes: "Database page creation and querying map; simple property types are translated, manual filters and content blocks are dropped; other operations become placeholders.",
      handler: dispatchOperations(
        kit,
        "Notion",
        { resource: "databasePage", operation: "create" },
        { "databasePage/create": notionDatabasePageCreate, "databasePage/getAll": notionDatabasePageGetAll }
      )
    }
  ];
}
