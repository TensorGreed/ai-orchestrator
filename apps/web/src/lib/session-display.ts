import type { SessionAuthMethod, SessionPolicyView } from "./api";

/** A short device label ("Chrome on macOS") from a user agent string; "Unknown device" when there is none. */
export function describeUserAgent(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "Unknown device";

  let browser: string | null = null;
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) browser = "Edge";
  else if (/\bOPR\/|\bOpera\b/.test(ua)) browser = "Opera";
  else if (/\bFirefox\/|\bFxiOS\//.test(ua)) browser = "Firefox";
  else if (/\bChrome\/|\bCriOS\/|\bChromium\//.test(ua)) browser = "Chrome";
  else if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) browser = "Safari";
  else if (/\bcurl\//i.test(ua)) browser = "curl";

  let os: string | null = null;
  if (/\biPhone\b|\biPad\b|\biPod\b/.test(ua)) os = "iOS";
  else if (/\bAndroid\b/.test(ua)) os = "Android";
  else if (/\bWindows\b/.test(ua)) os = "Windows";
  else if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) os = "macOS";
  else if (/\bCrOS\b/.test(ua)) os = "ChromeOS";
  else if (/\bLinux\b/.test(ua)) os = "Linux";

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
}

const AUTH_METHOD_LABELS: Record<SessionAuthMethod, string> = {
  password: "Password",
  oidc: "SSO (OIDC)",
  saml: "SSO (SAML)",
  ldap: "LDAP",
  break_glass: "Break-glass"
};

export function authMethodLabel(method: SessionAuthMethod | null | undefined): string {
  return method ? AUTH_METHOD_LABELS[method] ?? method : "—";
}

function formatMinutes(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function formatHours(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "1 day" : `${days} days`;
  }
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** One read-only line describing the session policy that applies to the signed-in user. */
export function describeSessionPolicy(policy: SessionPolicyView): string {
  const idle = policy.idleTimeoutMinutes ? formatMinutes(policy.idleTimeoutMinutes) : "not set";
  const lifetime = formatHours(policy.absoluteTimeoutHours);
  const limit = policy.maxPerUser ? `${policy.maxPerUser} per user` : "not set";
  return `Idle timeout: ${idle} · Maximum session length: ${lifetime} · Session limit: ${limit}`;
}
