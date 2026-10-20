/**
 * App handlers: chat tools (Slack, Telegram, Discord).
 *
 * Source app nodes are resource/operation shaped; each table below maps the
 * `(resource, operation)` pairs L2M covers onto the existing connector nodes
 * and leaves everything else to the unsupported placeholder.
 */
import type { ConversionContext, ExpressionScope } from "../handler-types.js";
import {
  dispatchOperations,
  droppedOptions,
  eventFilterReason,
  finish,
  resolveLocatorId,
  type AppKit,
  type AppRegistration,
  type OperationHandler
} from "./kit.js";

const BASE = "n8n-nodes-base.";

// --- Slack ------------------------------------------------------------------

const SLACK_CHANNEL_URL = /\/(?:archives|client\/[A-Z0-9]+)\/([CDG][A-Z0-9]+)/;
const SLACK_OTHER_OPTIONS_KEPT = ["thread_ts"] as const;

const slackPostMessage: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const reasons: Array<string | undefined> = [];
  const select = kit.asString(params.select) || (params.user !== undefined && params.channelId === undefined ? "user" : "channel");
  const target = select === "user"
    ? resolveLocatorId(kit, ctx, scope, params.user, "Slack user", "user")
    : resolveLocatorId(kit, ctx, scope, params.channelId, "Slack channel", "channelId", SLACK_CHANNEL_URL);
  reasons.push(target.reason);

  const config: Record<string, unknown> = {
    authType: "bot",
    channel: target.id,
    text: kit.tpl(params.text, ctx, scope, "text"),
    secretRef: kit.appSecret(source, ctx, scope, slackCredentialType(source), "Slack bot token")
  };

  const messageType = kit.asString(params.messageType, "text");
  if (messageType === "block") {
    const blocks = kit.tpl(params.blocksUi, ctx, scope, "blocksUi").trim();
    if (blocks) config.blocks = blocks;
  } else if (messageType === "attachment") {
    reasons.push("Message attachments are not supported; only the text was imported.");
  }

  const otherOptions = kit.toRecord(params.otherOptions);
  const threadTs = kit.asString(kit.toRecord(kit.toRecord(otherOptions.thread_ts).replyValues).thread_ts).trim();
  if (threadTs) config.threadTs = kit.tpl(threadTs, ctx, scope, "otherOptions.thread_ts");
  const dropped = droppedOptions(kit, otherOptions, SLACK_OTHER_OPTIONS_KEPT);
  if (dropped.length) reasons.push(`Message options (${dropped.join(", ")}) are not supported and were dropped.`);

  return finish(kit, kit.baseNode(source, scope, "slack_send_message", config), reasons);
};

function slackCredentialType(source: { credentials: Record<string, unknown> }): string {
  return "slackOAuth2Api" in source.credentials ? "slackOAuth2Api" : "slackApi";
}

function slackTrigger(kit: AppKit): AppRegistration["handler"] {
  return (source, ctx, scope) => {
    const params = source.parameters;
    const config: Record<string, unknown> = {
      path: kit.slugifyNodeId(source.name),
      signingSecretRef: kit.appSecret(source, ctx, scope, slackCredentialType(source), "Slack signing secret"),
      replayToleranceSeconds: 300
    };
    const reasons: Array<string | undefined> = [eventFilterReason(kit, params.trigger)];
    const channel = resolveLocatorId(kit, ctx, scope, params.channelId, "Slack channel", "channelId", SLACK_CHANNEL_URL);
    if (channel.id && params.watchWorkspace !== true) {
      reasons.push(`The channel filter (${channel.id}) is not supported; events from every channel reach the trigger.`);
    }
    reasons.push("Point the Slack event subscription at the imported webhook path after import.");
    return finish(kit, kit.baseNode(source, scope, "slack_trigger", config), reasons);
  };
}

// --- Telegram ---------------------------------------------------------------

const TELEGRAM_PARSE_MODES = new Set(["Markdown", "MarkdownV2", "HTML"]);
const TELEGRAM_FIELDS_KEPT = ["parse_mode", "disable_web_page_preview"] as const;

const telegramSendMessage: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  const reasons: Array<string | undefined> = [];
  const config: Record<string, unknown> = {
    chatId: kit.tpl(params.chatId, ctx, scope, "chatId"),
    text: kit.tpl(params.text, ctx, scope, "text"),
    secretRef: kit.appSecret(source, ctx, scope, "telegramApi", "Telegram bot token")
  };
  if (!config.chatId) reasons.push("No chat id was set; fill in chatId after import.");

  const fields = kit.toRecord(params.additionalFields);
  const parseMode = kit.asString(fields.parse_mode).trim();
  if (TELEGRAM_PARSE_MODES.has(parseMode)) config.parseMode = parseMode;
  if (fields.disable_web_page_preview === true) config.disableWebPagePreview = true;
  const dropped = droppedOptions(kit, fields, TELEGRAM_FIELDS_KEPT);
  if (dropped.length) reasons.push(`Message options (${dropped.join(", ")}) are not supported and were dropped.`);

  const replyMarkup = kit.asString(params.replyMarkup, "none");
  if (replyMarkup !== "none") reasons.push(`Reply markup '${replyMarkup}' is not supported; the message is sent without a keyboard.`);

  return finish(kit, kit.baseNode(source, scope, "telegram_send_message", config), reasons);
};

function telegramTrigger(kit: AppKit): AppRegistration["handler"] {
  return (source, ctx, scope) => {
    const config: Record<string, unknown> = {
      path: kit.slugifyNodeId(source.name),
      signingSecretRef: kit.appSecret(source, ctx, scope, "telegramApi", "Telegram webhook secret token")
    };
    const reasons = [
      eventFilterReason(kit, source.parameters.updates, "Update filters"),
      "Register the imported webhook path with the bot's setWebhook call after import."
    ];
    return finish(kit, kit.baseNode(source, scope, "telegram_trigger", config), reasons);
  };
}

// --- Discord ----------------------------------------------------------------

const DISCORD_OPTIONS_KEPT = ["username"] as const;

function discordEmbeds(kit: AppKit, ctx: ConversionContext, scope: ExpressionScope, raw: unknown): unknown[] {
  const values = kit.toArray(kit.toRecord(raw).values);
  return values.map((entry, index) => {
    const embed = kit.toRecord(entry);
    const out: Record<string, unknown> = {};
    for (const key of ["title", "description", "url", "color", "author", "image", "thumbnail", "video", "footer", "timestamp"]) {
      const value = embed[key];
      if (value === undefined || value === "") continue;
      out[key] = typeof value === "string" ? kit.tpl(value, ctx, scope, `embeds.values[${index}].${key}`) : value;
    }
    return out;
  });
}

const discordSendMessage: OperationHandler = (source, ctx, scope, kit) => {
  const params = source.parameters;
  // Version 1 of the source node only knew webhook sends; later versions default to a bot token.
  const authentication = kit.asString(params.authentication, (source.typeVersion ?? 1) < 2 ? "webhook" : "botToken");
  if (authentication !== "webhook") {
    return kit.unsupportedPlaceholder(
      source,
      scope,
      `Discord message sending with '${authentication}' authentication has no L2M equivalent (only webhook sends are supported); imported as a disabled placeholder.`
    );
  }
  const reasons: Array<string | undefined> = [];
  const options = kit.toRecord(params.options);
  const config: Record<string, unknown> = {
    webhookUrl: kit.tpl(params.webhookUri, ctx, scope, "webhookUri"),
    content: kit.tpl(params.content ?? params.text, ctx, scope, params.content !== undefined ? "content" : "text"),
    secretRef: kit.appSecret(source, ctx, scope, "discordWebhookApi", "Discord webhook URL")
  };
  if (!config.webhookUrl) {
    reasons.push("The webhook URL lives in the source credential; set webhookUrl after import (the secret placeholder tracks that credential).");
  }
  const username = kit.asString(options.username).trim();
  if (username) config.username = kit.tpl(username, ctx, scope, "options.username");

  const embeds = discordEmbeds(kit, ctx, scope, params.embeds);
  if (embeds.length) config.embedsJson = JSON.stringify(embeds);

  const dropped = droppedOptions(kit, options, DISCORD_OPTIONS_KEPT);
  if (dropped.length) reasons.push(`Message options (${dropped.join(", ")}) are not supported and were dropped.`);
  if (kit.toArray(kit.toRecord(params.files).values).length) reasons.push("File attachments are not supported and were dropped.");

  return finish(kit, kit.baseNode(source, scope, "discord_send_message", config), reasons);
};

function discordHandler(kit: AppKit): AppRegistration["handler"] {
  const dispatch = dispatchOperations(kit, "Discord", { resource: "channel", operation: "get" }, { "message/send": discordSendMessage });
  return (source, ctx, scope) => ((source.typeVersion ?? 1) < 2 ? discordSendMessage(source, ctx, scope, kit) : dispatch(source, ctx, scope));
}

function discordTrigger(kit: AppKit): AppRegistration["handler"] {
  return (source, ctx, scope) => {
    const params = source.parameters;
    const config: Record<string, unknown> = {
      path: kit.slugifyNodeId(source.name),
      publicKey: ""
    };
    const reasons = [
      eventFilterReason(kit, params.events ?? params.trigger),
      "The application public key is not part of the export; set publicKey after import and point the interactions endpoint at the webhook path."
    ];
    return finish(kit, kit.baseNode(source, scope, "discord_trigger", config), reasons);
  };
}

// --- Registrations -----------------------------------------------------------

export function chatAppRegistrations(kit: AppKit): AppRegistration[] {
  return [
    {
      sourceType: `${BASE}slack`,
      targetType: "slack_send_message",
      notes: "Message posting maps to a bot-token send; attachments and most message options are dropped; other resources and operations become placeholders.",
      handler: dispatchOperations(kit, "Slack", { resource: "message", operation: "post" }, { "message/post": slackPostMessage })
    },
    {
      sourceType: `${BASE}slackTrigger`,
      targetType: "slack_trigger",
      notes: "Event and channel filters are not supported; the signing secret becomes a placeholder.",
      handler: slackTrigger(kit)
    },
    {
      sourceType: `${BASE}telegram`,
      targetType: "telegram_send_message",
      notes: "Text messages map directly; keyboards and most options are dropped; other resources and operations become placeholders.",
      handler: dispatchOperations(kit, "Telegram", { resource: "message", operation: "sendMessage" }, { "message/sendMessage": telegramSendMessage })
    },
    {
      sourceType: `${BASE}telegramTrigger`,
      targetType: "telegram_trigger",
      notes: "Update filters are not supported; the webhook secret token becomes a placeholder.",
      handler: telegramTrigger(kit)
    },
    {
      sourceType: `${BASE}discord`,
      targetType: "discord_send_message",
      notes: "Webhook sends map with content, username and embeds; bot-token sends and other operations become placeholders.",
      handler: discordHandler(kit)
    },
    {
      sourceType: `${BASE}discordTrigger`,
      targetType: "discord_trigger",
      notes: "Event filters are not supported; the application public key must be set after import.",
      handler: discordTrigger(kit)
    }
  ];
}
