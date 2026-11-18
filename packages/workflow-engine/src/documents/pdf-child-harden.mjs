// Loaded first by the PDF reader child (pdf-child.mjs), before pdf.js: it takes away what the permission model leaves
// open to code running in the child. The console is silenced; the web network APIs are removed (the permission model
// covers sockets only from Node 25 on); and process.kill is removed, so the child cannot signal any other process (on
// Node 24, SIGUSR1 to the API process would open its debugger).

for (const method of ["log", "info", "warn", "error", "debug", "trace", "dir", "table"]) {
  console[method] = () => {};
}
for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) {
  try {
    delete globalThis[name];
  } catch {
    globalThis[name] = undefined;
  }
}
for (const name of ["kill", "_kill"]) {
  try {
    delete process[name];
  } catch {
    process[name] = undefined;
  }
}
