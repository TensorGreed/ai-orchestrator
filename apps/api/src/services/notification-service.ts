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
}

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

function describeEvent(event: NotificationEvent): NotificationContent {
  const facts: NotificationContent["facts"] = [
    { name: "Workflow", value: event.workflowName },
    { name: "Workflow ID", value: event.workflowId },
    ...(event.executionId ? [{ name: "Execution ID", value: event.executionId }] : []),
    { name: "Time", value: event.timestamp }
  ];
  if (event.type === "approval.requested" || event.type === "approval.timed_out") {
    const approval = event.approval;
    const requested = event.type === "approval.requested";
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
      text: requested ? "A run is waiting for approval. Open the approvals inbox to see the request." : "Nobody decided before the approval expired.",
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

function escapeHtml(value: string): string {
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

export class NotificationService {
  private channels: NotificationChannel[] = [];

  constructor(
    private config: AppConfig,
    private listConfigs: () => NotificationChannel[]
  ) {
    this.reload();
  }

  /** Events the env-configured channels receive; Phase 11.2 adds approval events unless turned off. */
  private envChannelEvents(): string[] {
    return this.config.NOTIFICATIONS_APPROVAL_EVENTS ? ["execution.failure", ...APPROVAL_NOTIFICATION_EVENTS] : ["execution.failure"];
  }

  reload(): void {
    this.channels = this.listConfigs();

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

  async notify(event: NotificationEvent): Promise<void> {
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

  private async sendToChannel(channel: NotificationChannel, event: NotificationEvent): Promise<void> {
    if (channel.channel === "slack") {
      await this.sendSlack(channel.config, event);
    } else if (channel.channel === "teams") {
      await this.sendTeams(channel.config, event);
    } else if (channel.channel === "email") {
      await this.sendEmail(channel.config, event);
    }
  }

  private async sendSlack(config: Record<string, unknown>, event: NotificationEvent): Promise<void> {
    const webhookUrl = String(config.webhookUrl ?? "");
    if (!webhookUrl) return;
    const content = describeEvent(event);
    const lines = [`${content.icon} *${escapeSlack(content.title)}*`, escapeSlack(content.text), ...content.facts.map((fact) => `*${fact.name}:* ${escapeSlack(fact.value)}`)];
    if (content.link) lines.push(`<${content.link}|Open the approvals inbox>`);
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") })
    });
  }

  private async sendTeams(config: Record<string, unknown>, event: NotificationEvent): Promise<void> {
    const webhookUrl = String(config.webhookUrl ?? "");
    if (!webhookUrl) return;
    const content = describeEvent(event);
    const card = {
      "@type": "MessageCard",
      themeColor: content.color,
      title: escapeTeams(content.title),
      text: escapeTeams(content.text),
      sections: [{ facts: content.facts.map((fact) => ({ name: escapeTeams(fact.name), value: escapeTeams(fact.value) })) }],
      ...(content.link ? { potentialAction: [{ "@type": "OpenUri", name: "Open the approvals inbox", targets: [{ os: "default", uri: content.link }] }] } : {})
    };
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(card)
    });
  }

  private async sendEmail(config: Record<string, unknown>, event: NotificationEvent): Promise<void> {
    const host = String(config.host ?? "");
    const to = String(config.to ?? "");
    if (!host || !to) return;
    try {
      const nodemailer = await import("nodemailer" as string) as { default: { createTransport: (opts: unknown) => { sendMail: (msg: unknown) => Promise<unknown> } } };
      const transporter = nodemailer.default.createTransport({
        host,
        port: Number(config.port ?? 587),
        secure: Boolean(config.secure),
        ...(config.user ? { auth: { user: String(config.user), pass: String(config.pass ?? "") } } : {})
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
    } catch (err) {
      console.warn("[Notification] Email send failed:", err);
    }
  }
}
