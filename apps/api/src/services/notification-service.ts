import { CREDENTIAL_EXPIRING_EVENT, type CredentialExpiryReason, type CredentialKind } from "@ai-orchestrator/shared";
import type { AppConfig } from "../config";

interface NotificationChannel {
  channel: string;
  enabled: boolean;
  config: Record<string, unknown>;
  events: string[];
}

export interface NotificationEvent {
  type: string; // "execution.failure" | "execution.success" | "approval.requested" | "approval.timed_out"
  workflowId: string;
  workflowName: string;
  executionId?: string;
  error?: string;
  errorStack?: string;
  timestamp: string;
  /** Phase 11.2 — set for approval events. */
  approval?: {
    requestId: string;
    nodeId: string;
    expiresAt: string | null;
    /** Who may decide, as shown to people (roles and users). */
    approvers: string;
    /** Link to the approvals inbox, when a public app URL is configured. */
    link?: string;
    /** For approval.timed_out: what the run does now. */
    outcome?: string;
  };
  /** Phase 15.4 — set when the approval is a release request: which version waits to be published. */
  release?: { version: number };
  /** Phase 13.2 — set for network.break_glass_used: who came in through a break-glass range, and where. */
  network?: { ip: string; scope: string; method: string; path: string };
  /** 13.2 — set for auth.break_glass_used: which stage of a break-glass sign-in, for which admin. Never the link. */
  auth?: {
    stage: "issued" | "used" | "ended";
    email: string;
    userId: string;
    /** Issued: where the command ran (host name and OS user). */
    origin?: string;
    /** Used: the browser's address. */
    ipAddress?: string | null;
    /** Issued: when the link stops working; used: when the session ends. */
    expiresAt?: string;
    /** Ended: why (logout, expired, admin, ...). */
    reason?: string;
  };
  /** 13.2 — set for credential.expiring: which key or gateway client stops working, and when. Never the secret. */
  credential?: {
    kind: CredentialKind;
    reason: CredentialExpiryReason;
    id: string;
    name: string;
    prefix: string;
    expiresAt: string;
    owner: string | null;
  };
}

/** Phase 13.2 — an address outside the ui/api allowlist was admitted because it is in NETWORK_BREAK_GLASS_CIDRS. */
export const NETWORK_NOTIFICATION_EVENTS = ["network.break_glass_used"] as const;

/**
 * 13.2 — a break-glass sign-in: the link was minted on the host, used, or its session ended (one event, `auth.stage`
 * says which). The same name as BREAK_GLASS_SIGN_IN_EVENT in @ai-orchestrator/shared.
 */
export const AUTH_NOTIFICATION_EVENTS = ["auth.break_glass_used"] as const;

/** 13.2 — a key or gateway client stops working soon; channels set in the environment take it with NOTIFICATIONS_CREDENTIAL_EVENTS=true. */
export const CREDENTIAL_NOTIFICATION_EVENTS = [CREDENTIAL_EXPIRING_EVENT] as const;

const CREDENTIAL_KIND_LABEL: Record<CredentialKind, string> = {
  api_key: "API key",
  service_account_key: "Service account key",
  mcp_client: "Gateway client"
};

/** Phase 11.2 — approval events channels subscribe to alongside execution events. */
export const APPROVAL_NOTIFICATION_EVENTS = ["approval.requested", "approval.timed_out"] as const;

interface NotificationContent {
  title: string;
  /** Short status for Slack's first line. */
  icon: string;
  color: string;
  facts: Array<{ name: string; value: string }>;
  text: string;
  link?: string;
}

const BREAK_GLASS_STAGE_TEXT: Record<NonNullable<NotificationEvent["auth"]>["stage"], { title: string; text: string }> = {
  issued: {
    title: "Break-glass sign-in link issued",
    text: "Someone with shell access to the server minted a one-time admin sign-in link. If this was not planned, treat it as an incident."
  },
  used: {
    title: "Break-glass sign-in used",
    text: "A break-glass link was used: an admin session is open, exempt from the sign-in policies. Every request is recorded in the audit log."
  },
  ended: {
    title: "Break-glass session ended",
    text: "The break-glass session is over. Review its requests in the audit log (auth.break_glass_request)."
  }
};

function describeEvent(event: NotificationEvent): NotificationContent {
  if (event.type === CREDENTIAL_EXPIRING_EVENT && event.credential) {
    const credential = event.credential;
    const label = CREDENTIAL_KIND_LABEL[credential.kind];
    const facts: NotificationContent["facts"] = [
      { name: label, value: `${credential.name} (${credential.prefix})` },
      ...(credential.owner ? [{ name: credential.kind === "mcp_client" ? "Created by" : "Owner", value: credential.owner }] : []),
      { name: "Stops working", value: credential.expiresAt },
      { name: "Time", value: event.timestamp }
    ];
    const rotationGrace = credential.reason === "rotation_grace";
    return {
      title: rotationGrace ? `Rotated key still in use: ${credential.name}` : `${label} expiring: ${credential.name}`,
      icon: "\u23F3",
      color: "F2B705",
      facts,
      text: rotationGrace
        ? "This key was rotated and its grace window ends soon, but something still signs in with the old key. Switch that caller to the new key before it stops working."
        : credential.kind === "mcp_client"
          ? "This gateway client stops working soon. Create a new client, or rotate this one and give its callers the new token."
          : "This key stops working soon. Rotate it (Settings) and give its callers the new key."
    };
  }
  if (event.type === "auth.break_glass_used" && event.auth) {
    const stage = BREAK_GLASS_STAGE_TEXT[event.auth.stage];
    const facts: NotificationContent["facts"] = [{ name: "Account", value: event.auth.email }];
    if (event.auth.origin) facts.push({ name: "Issued from", value: event.auth.origin });
    if (event.auth.ipAddress) facts.push({ name: "Address", value: event.auth.ipAddress });
    if (event.auth.expiresAt) facts.push({ name: event.auth.stage === "issued" ? "Link expires" : "Session ends", value: event.auth.expiresAt });
    if (event.auth.reason) facts.push({ name: "Reason", value: event.auth.reason });
    facts.push({ name: "Time", value: event.timestamp });
    return { title: stage.title, icon: "\u{1F6A8}", color: "FF0000", facts, text: stage.text };
  }
  if (event.type === "network.break_glass_used" && event.network) {
    return {
      title: "Break-glass access used",
      icon: "\u{1F6A8}",
      color: "FF0000",
      facts: [
        { name: "Address", value: event.network.ip },
        { name: "Scope", value: event.network.scope },
        { name: "Request", value: `${event.network.method} ${event.network.path}` },
        { name: "Time", value: event.timestamp }
      ],
      text: "A request from a break-glass address was admitted outside the network allowlist. Check the audit log for network.break_glass_used."
    };
  }
  const facts: NotificationContent["facts"] = [
    { name: "Workflow", value: event.workflowName },
    { name: "Workflow ID", value: event.workflowId },
    ...(event.executionId ? [{ name: "Execution ID", value: event.executionId }] : []),
    { name: "Time", value: event.timestamp }
  ];
  if (event.type === "approval.requested" || event.type === "approval.timed_out") {
    const approval = event.approval;
    const requested = event.type === "approval.requested";
    if (event.release) facts.push({ name: "Version", value: String(event.release.version) });
    if (approval) {
      facts.push({ name: "Approvers", value: approval.approvers });
      if (requested && approval.expiresAt) facts.push({ name: "Expires", value: approval.expiresAt });
      if (!requested && approval.outcome) facts.push({ name: "Outcome", value: approval.outcome });
    }
    return {
      title: `${requested ? "Approval needed" : "Approval timed out"}: ${event.workflowName}`,
      icon: requested ? "\u{1F7E1}" : "\u23F0",
      color: requested ? "F2B705" : "8A8F98",
      facts,
      // Channels are not scoped to a project, so the run's own text (the
      // request message, proposed values) stays in the project-scoped inbox.
      text: event.release
        ? requested
          ? "A workflow version is waiting for approval to be published. Open the approvals inbox to see the request."
          : "Nobody decided on the release request before it expired, so the version was not published."
        : requested
          ? "A run is waiting for approval. Open the approvals inbox to see the request."
          : "Nobody decided before the approval expired.",
      ...(approval?.link ? { link: approval.link } : {})
    };
  }
  const failed = event.type === "execution.failure";
  if (event.error) facts.push({ name: "Error", value: event.error });
  return {
    title: `Workflow ${failed ? "Failed" : "Succeeded"}: ${event.workflowName}`,
    icon: failed ? "\u{1F6A8}" : "\u2705",
    color: failed ? "FF0000" : "00FF00",
    facts,
    text: event.error ?? "Execution completed"
  };
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Teams renders MessageCard text as Markdown, and some clients a little HTML: escape both so run input cannot add links, images, emphasis or markup. */
export function escapeTeams(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]()]/g, (char) => `\\${char}`);
}

/** Slack mrkdwn treats `<`, `>` and `&` as control characters. */
function escapeSlack(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 13.2 — what `notifyWithResults` reports. */
export interface NotifyResult {
  /** Enabled channels subscribed to the event. */
  matched: number;
  /** Channels that took it. */
  delivered: number;
  failures: Array<{ channel: string; error: string }>;
}

async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class NotificationService {
  private channels: NotificationChannel[] = [];
  /** The latest channel load; `notify` waits for it so a send never uses channels from before a change. */
  private loaded: Promise<void>;

  constructor(
    private config: AppConfig,
    private listConfigs: () => NotificationChannel[] | Promise<NotificationChannel[]>
  ) {
    this.loaded = this.load().catch(() => undefined);
  }

  /** Events the env-configured channels receive; Phase 11.2 adds approval events unless turned off. */
  private envChannelEvents(): string[] {
    const events = this.config.NOTIFICATIONS_APPROVAL_EVENTS ? ["execution.failure", ...APPROVAL_NOTIFICATION_EVENTS] : ["execution.failure"];
    // Phase 13.2 — break-glass alerts reach the env channels too (they only fire when an allowlist is set).
    // 13.2 — credential expiry warnings only when asked for, so an install that sets nothing sees no new alerts.
    const credential = this.config.NOTIFICATIONS_CREDENTIAL_EVENTS ? CREDENTIAL_NOTIFICATION_EVENTS : [];
    return [...events, ...NETWORK_NOTIFICATION_EVENTS, ...AUTH_NOTIFICATION_EVENTS, ...credential];
  }

  /** 13.2 — whether any enabled channel takes this event now (a sweep with no audience claims and sends nothing). */
  async subscribes(eventType: string): Promise<boolean> {
    try {
      await this.loaded;
    } catch {
      // A failed load keeps the previous channels.
    }
    return this.channels.some((channel) => channel.enabled && channel.events.includes(eventType));
  }

  /** Reloads the channels from the stored configs (plus the env-configured defaults). */
  reload(): Promise<void> {
    const loading = this.load();
    // A failed load keeps the previous channels; the next reload tries again.
    this.loaded = loading.catch(() => undefined);
    return loading;
  }

  private async load(): Promise<void> {
    const channels = [...(await this.listConfigs())];
    this.channels = channels;

    // Also add env-var-based defaults if no DB configs exist
    if (this.config.NOTIFICATIONS_ENABLED) {
      if (this.config.NOTIFICATION_SLACK_WEBHOOK_URL && !this.channels.some(c => c.channel === "slack")) {
        this.channels.push({
          channel: "slack",
          enabled: true,
          config: { webhookUrl: this.config.NOTIFICATION_SLACK_WEBHOOK_URL },
          events: this.envChannelEvents()
        });
      }
      if (this.config.NOTIFICATION_TEAMS_WEBHOOK_URL && !this.channels.some(c => c.channel === "teams")) {
        this.channels.push({
          channel: "teams",
          enabled: true,
          config: { webhookUrl: this.config.NOTIFICATION_TEAMS_WEBHOOK_URL },
          events: this.envChannelEvents()
        });
      }
      if (this.config.NOTIFICATION_SMTP_HOST && this.config.NOTIFICATION_EMAIL_TO && !this.channels.some(c => c.channel === "email")) {
        this.channels.push({
          channel: "email",
          enabled: true,
          config: {
            host: this.config.NOTIFICATION_SMTP_HOST,
            port: this.config.NOTIFICATION_SMTP_PORT,
            secure: this.config.NOTIFICATION_SMTP_SECURE,
            user: this.config.NOTIFICATION_SMTP_USER,
            pass: this.config.NOTIFICATION_SMTP_PASS,
            from: this.config.NOTIFICATION_EMAIL_FROM || "notifications@ai-orchestrator",
            to: this.config.NOTIFICATION_EMAIL_TO
          },
          events: this.envChannelEvents()
        });
      }
    }
  }

  /**
   * 13.2 — sends like `notify`, and says what happened: how many enabled channels subscribe to the event, how many
   * took it, and why the others failed. Each send is bounded by `timeoutMs`. Never throws.
   */
  async notifyWithResults(event: NotificationEvent, options: { timeoutMs: number }): Promise<NotifyResult> {
    try {
      await this.loaded;
    } catch {
      // A failed load keeps the previous channels (none on the first load).
    }
    const matching = this.channels.filter((c) => c.enabled && c.events.includes(event.type));
    const results = await Promise.allSettled(matching.map((c) => withDeadline(this.sendToChannel(c, event, options.timeoutMs), options.timeoutMs, c.channel)));
    const failures: NotifyResult["failures"] = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        failures.push({ channel: matching[index]!.channel, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      }
    });
    return { matched: matching.length, delivered: matching.length - failures.length, failures };
  }

  async notify(event: NotificationEvent): Promise<void> {
    await this.loaded;
    const matching = this.channels.filter(c => c.enabled && c.events.includes(event.type));
    const results = await Promise.allSettled(
      matching.map(c => this.sendToChannel(c, event))
    );
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("[Notification] Failed to send to channel:", r.reason);
      }
    }
  }

  /**
   * Roadmap 7.3 — an email to one person (a user invite) through the SMTP server set in the environment
   * (NOTIFICATIONS_ENABLED and NOTIFICATION_SMTP_HOST). False when none is set or the send failed, so the caller can
   * hand the message's link over another way.
   */
  async sendDirectEmail(message: { to: string; subject: string; html: string; text: string }): Promise<boolean> {
    if (!this.config.NOTIFICATIONS_ENABLED || !this.config.NOTIFICATION_SMTP_HOST) return false;
    try {
      const nodemailer = await import("nodemailer" as string) as { default: { createTransport: (opts: unknown) => { sendMail: (msg: unknown) => Promise<unknown> } } };
      const transporter = nodemailer.default.createTransport({
        host: this.config.NOTIFICATION_SMTP_HOST,
        port: this.config.NOTIFICATION_SMTP_PORT,
        secure: this.config.NOTIFICATION_SMTP_SECURE,
        ...(this.config.NOTIFICATION_SMTP_USER ? { auth: { user: this.config.NOTIFICATION_SMTP_USER, pass: this.config.NOTIFICATION_SMTP_PASS ?? "" } } : {})
      });
      await transporter.sendMail({
        from: this.config.NOTIFICATION_EMAIL_FROM || "notifications@ai-orchestrator",
        to: message.to,
        subject: message.subject.replace(/[\r\n]+/g, " "),
        html: message.html,
        text: message.text
      });
      return true;
    } catch (err) {
      console.warn("[Notification] Direct email send failed:", err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** Rejects when the channel did not take the message (a non-2xx answer, a refused or failed send). */
  private async sendToChannel(channel: NotificationChannel, event: NotificationEvent, timeoutMs?: number): Promise<void> {
    if (channel.channel === "slack") {
      await this.sendSlack(channel.config, event, timeoutMs);
    } else if (channel.channel === "teams") {
      await this.sendTeams(channel.config, event, timeoutMs);
    } else if (channel.channel === "email") {
      await this.sendEmail(channel.config, event, timeoutMs);
    }
  }

  private async sendSlack(config: Record<string, unknown>, event: NotificationEvent, timeoutMs?: number): Promise<void> {
    const webhookUrl = String(config.webhookUrl ?? "");
    if (!webhookUrl) throw new Error("Slack channel has no webhook URL");
    const content = describeEvent(event);
    const lines = [`${content.icon} *${escapeSlack(content.title)}*`, escapeSlack(content.text), ...content.facts.map((fact) => `*${fact.name}:* ${escapeSlack(fact.value)}`)];
    if (content.link) lines.push(`<${content.link}|Open the approvals inbox>`);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {})
    });
    // A rotated or deleted webhook answers 404/410: that is a failed send, not a delivered one.
    if (!response.ok) throw new Error(`Slack webhook answered HTTP ${response.status}`);
  }

  private async sendTeams(config: Record<string, unknown>, event: NotificationEvent, timeoutMs?: number): Promise<void> {
    const webhookUrl = String(config.webhookUrl ?? "");
    if (!webhookUrl) throw new Error("Teams channel has no webhook URL");
    const content = describeEvent(event);
    const card = {
      "@type": "MessageCard",
      themeColor: content.color,
      title: escapeTeams(content.title),
      text: escapeTeams(content.text),
      sections: [{ facts: content.facts.map((fact) => ({ name: escapeTeams(fact.name), value: escapeTeams(fact.value) })) }],
      ...(content.link ? { potentialAction: [{ "@type": "OpenUri", name: "Open the approvals inbox", targets: [{ os: "default", uri: content.link }] }] } : {})
    };
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(card),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {})
    });
    if (!response.ok) throw new Error(`Teams webhook answered HTTP ${response.status}`);
  }

  private async sendEmail(config: Record<string, unknown>, event: NotificationEvent, timeoutMs?: number): Promise<void> {
    const host = String(config.host ?? "");
    const to = String(config.to ?? "");
    if (!host || !to) throw new Error("Email channel has no SMTP host or recipient");
    const nodemailer = await import("nodemailer" as string) as { default: { createTransport: (opts: unknown) => { sendMail: (msg: unknown) => Promise<unknown> } } };
    const transporter = nodemailer.default.createTransport({
      host,
      port: Number(config.port ?? 587),
      secure: Boolean(config.secure),
      ...(config.user ? { auth: { user: String(config.user), pass: String(config.pass ?? "") } } : {}),
      ...(timeoutMs ? { connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs } : {})
    });
    const content = describeEvent(event);
    const rows = content.facts
      .map((fact) => `<tr><td style="padding:4px 12px;font-weight:bold;">${escapeHtml(fact.name)}</td><td style="padding:4px 12px;">${escapeHtml(fact.value)}</td></tr>`)
      .join("\n");
    await transporter.sendMail({
      from: String(config.from ?? "notifications@ai-orchestrator"),
      to,
      subject: `[AI Orchestrator] ${content.title.replace(/[\r\n]+/g, " ")}`,
      html: `<h2>${escapeHtml(content.title)}</h2>
<p>${escapeHtml(content.text)}</p>
<table style="border-collapse:collapse;font-family:sans-serif;">
${rows}
</table>${content.link ? `\n<p><a href="${escapeHtml(content.link)}">Open the approvals inbox</a></p>` : ""}`
    });
  }
}
