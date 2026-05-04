export interface LimitedText {
  text: string;
  truncated: boolean;
  originalChars: number;
  includedChars: number;
}

export class ContextBudget {
  private usedChars = 0;
  private readonly truncatedItems: string[] = [];

  constructor(private readonly maxChars: number) {}

  take(label: string, value: string, itemMaxChars: number): LimitedText {
    const normalized = normalizeNewlines(value);
    const originalChars = normalized.length;
    const remaining = Math.max(0, this.maxChars - this.usedChars);
    const allowedChars = Math.max(0, Math.min(itemMaxChars, remaining));

    if (originalChars <= allowedChars) {
      this.usedChars += originalChars;
      return {
        text: normalized,
        truncated: false,
        originalChars,
        includedChars: originalChars
      };
    }

    const suffix = `\n\n[truncated ${Math.max(0, originalChars - allowedChars)} chars from ${label}]`;
    const prefixLength = Math.max(0, allowedChars - suffix.length);
    const text = allowedChars <= 0
      ? ""
      : `${normalized.slice(0, prefixLength)}${suffix}`.slice(0, allowedChars);
    this.usedChars += text.length;
    this.truncatedItems.push(label);

    return {
      text,
      truncated: true,
      originalChars,
      includedChars: text.length
    };
  }

  toJSON(): Record<string, unknown> {
    return {
      maxChars: this.maxChars,
      usedChars: this.usedChars,
      remainingChars: Math.max(0, this.maxChars - this.usedChars),
      truncated: this.truncatedItems.length > 0,
      truncatedItems: [...new Set(this.truncatedItems)]
    };
  }
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}
