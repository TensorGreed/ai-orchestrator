/**
 * 13.2 — rotating API keys and gateway client tokens, and showing when a credential stops working.
 *
 * RotateCredentialButton asks how long the old secret keeps working (24 hours unless the user picks another window,
 * or "now"), then calls the rotate route. CredentialExpiry shows the expiry date with a badge when it is close, and for
 * a rotated key when its grace window ends.
 */
import { useState } from "react";
import { CREDENTIAL_EXPIRY_WARNING_DAYS, KEY_ROTATION_GRACE_HOURS, daysUntilExpiry } from "@ai-orchestrator/shared";

/** The grace windows the studio offers (the API takes any whole number of hours from 0 to 168). */
export const GRACE_WINDOW_OPTIONS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 0, label: "Stop now" },
  { hours: 1, label: "1 hour" },
  { hours: KEY_ROTATION_GRACE_HOURS.default, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: KEY_ROTATION_GRACE_HOURS.max, label: "7 days" }
];

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** "Rotate", then a grace window picker and a confirm button. `what` names the old secret ("key", "token"). */
export function RotateCredentialButton({
  what,
  name,
  disabled,
  buttonClassName = "mini-btn",
  onRotate
}: {
  what: "key" | "token";
  name: string;
  disabled?: boolean;
  /** The buttons' class (the settings tables use mini buttons, the gateway views page buttons). */
  buttonClassName?: string;
  onRotate: (graceHours: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [graceHours, setGraceHours] = useState<number>(KEY_ROTATION_GRACE_HOURS.default);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button type="button" className={buttonClassName} disabled={disabled} onClick={() => setOpen(true)} aria-label={`Rotate ${name}`}>
        Rotate
      </button>
    );
  }
  return (
    <span className="settings-actions" role="group" aria-label={`Rotate ${name}`}>
      <label>
        Old {what} keeps working for{" "}
        <select aria-label={`Old ${what} keeps working for`} value={graceHours} onChange={(event) => setGraceHours(Number(event.target.value))}>
          {GRACE_WINDOW_OPTIONS.map((option) => (
            <option key={option.hours} value={option.hours}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className={buttonClassName}
        disabled={busy || disabled}
        onClick={async () => {
          setBusy(true);
          try {
            await onRotate(graceHours);
            setOpen(false);
            setGraceHours(KEY_ROTATION_GRACE_HOURS.default);
          } finally {
            setBusy(false);
          }
        }}
      >
        Rotate now
      </button>
      <button type="button" className={buttonClassName} disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}

/**
 * When a credential stops working: "never", the date, a badge within CREDENTIAL_EXPIRY_WARNING_DAYS, "expired", or for
 * a rotated key "rotated, works until <date>".
 */
export function CredentialExpiry({
  expiresAt,
  rotated,
  revoked,
  now = Date.now()
}: {
  expiresAt: string | null;
  rotated?: boolean;
  revoked?: boolean;
  now?: number;
}) {
  if (revoked) return <span className="settings-muted">{expiresAt ? formatWhen(expiresAt) : "never"}</span>;
  if (expiresAt && Date.parse(expiresAt) <= now) {
    return (
      <span className="status-pill" data-status="skipped">
        {rotated ? "rotated, ended" : "expired"}
      </span>
    );
  }
  if (rotated && expiresAt) {
    return (
      <span>
        <span className="status-pill" data-status="partial">
          rotated
        </span>{" "}
        works until {formatWhen(expiresAt)}
      </span>
    );
  }
  if (!expiresAt) return <span>never</span>;
  const days = daysUntilExpiry(expiresAt, now);
  const soon = days !== null && Date.parse(expiresAt) - now <= CREDENTIAL_EXPIRY_WARNING_DAYS * 86_400_000;
  return (
    <span>
      {formatWhen(expiresAt)}
      {soon && (
        <>
          {" "}
          <span className="status-pill" data-status="partial">
            {days === 0 ? "expires today" : days === 1 ? "expires in 1 day" : `expires in ${days} days`}
          </span>
        </>
      )}
    </span>
  );
}

/** The line shown with a new secret after a rotation: copy it now, and how long the old one keeps working. */
export function rotatedNotice(what: "key" | "token", previousExpiresAt: string | null | undefined): string {
  if (!previousExpiresAt || Date.parse(previousExpiresAt) <= Date.now()) return `The old ${what} has stopped working.`;
  return `The old ${what} keeps working until ${formatWhen(previousExpiresAt)}.`;
}
