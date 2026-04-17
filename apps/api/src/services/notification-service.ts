import type { AppConfig } from "../config";

interface NotificationChannel {
  channel: string;
  enabled: boolean;
  config: Record<string, unknown>;
  events: string[];
}

export interface NotificationEvent {
  type: string; // "execution.failure" | "execution.success"
  workflowId: string;
  workflowName: string;
  executionId?: string;
  error?: string;
  errorStack?: string;
  timestamp: string;
}

export class NotificationService {
  private channels: NotificationChannel[] = [];

  constructor(
    private config: AppConfig,
    private listConfigs: () => NotificationChannel[]
  ) {
    this.reload();
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
          events: ["execution.failure"]
        });
      }
      if (this.config.NOTIFICATION_TEAMS_WEBHOOK_URL && !this.channels.some(c => c.channel === "teams")) {
        this.channels.push({
          channel: "teams",
          enabled: true,
          config: { webhookUrl: this.config.NOTIFICATION_TEAMS_WEBHOOK_URL },
          events: ["execution.failure"]
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
          events: ["execution.failure"]
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
    const icon = event.type === "execution.failure" ? "\u{1F6A8}" : "\u2705";
    const label = event.type === "execution.failure" ? "Failed" : "Succeeded";
    const text = `${icon} *Workflow ${label}*\n*Workflow:* ${event.workflowName}\n*Error:* ${event.error ?? "None"}\n*Time:* ${event.timestamp}${event.executionId ? `\n*Execution:* ${event.executionId}` : ""}`;
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
  }

  private async sendTeams(config: Record<string, unknown>, event: NotificationEvent): Promise<void> {
    const webhookUrl = String(config.webhookUrl ?? "");
    if (!webhookUrl) return;
    const card = {
      "@type": "MessageCard",
      themeColor: event.type === "execution.failure" ? "FF0000" : "00FF00",
      title: `Workflow ${event.type === "execution.failure" ? "Failed" : "Succeeded"}: ${event.workflowName}`,
      text: event.error ?? "Execution completed",
      sections: [{
        facts: [
          { name: "Workflow", value: event.workflowName },
          { name: "Workflow ID", value: event.workflowId },
          ...(event.executionId ? [{ name: "Execution ID", value: event.executionId }] : []),
          { name: "Timestamp", value: event.timestamp }
        ]
      }]
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
      const label = event.type === "execution.failure" ? "Failed" : "Succeeded";
      await transporter.sendMail({
        from: String(config.from ?? "notifications@ai-orchestrator"),
        to,
        subject: `[AI Orchestrator] Workflow ${label}: ${event.workflowName}`,
        html: `<h2>Workflow ${label}</h2>
<table style="border-collapse:collapse;font-family:sans-serif;">
<tr><td style="padding:4px 12px;font-weight:bold;">Workflow</td><td style="padding:4px 12px;">${event.workflowName}</td></tr>
<tr><td style="padding:4px 12px;font-weight:bold;">Workflow ID</td><td style="padding:4px 12px;">${event.workflowId}</td></tr>
${event.executionId ? `<tr><td style="padding:4px 12px;font-weight:bold;">Execution ID</td><td style="padding:4px 12px;">${event.executionId}</td></tr>` : ""}
<tr><td style="padding:4px 12px;font-weight:bold;">Timestamp</td><td style="padding:4px 12px;">${event.timestamp}</td></tr>
${event.error ? `<tr><td style="padding:4px 12px;font-weight:bold;">Error</td><td style="padding:4px 12px;color:red;">${event.error}</td></tr>` : ""}
</table>`
      });
    } catch (err) {
      console.warn("[Notification] Email send failed:", err);
    }
  }
}
