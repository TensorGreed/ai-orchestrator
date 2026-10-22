/**
 * Non-blocking warnings the API returns when a secret is saved (for example
 * a value that is a common word run records keep as it is). The secret is
 * already saved; the warnings never contain its value.
 */
export function SecretSaveWarnings({ warnings, className }: { warnings: readonly string[] | null | undefined; className?: string }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div className={className ? `warn-banner ${className}` : "warn-banner"} role="status">
      {warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
    </div>
  );
}
