// Runs before the studio boots. The tour introduces the demo, so the studio's
// own first-visit welcome stays closed.
try {
  if (!window.localStorage.getItem("l2m:welcome-dismissed")) window.localStorage.setItem("l2m:welcome-dismissed", "1");
} catch {
  // Blocked storage: the welcome shows as it would anywhere else.
}

export {};
