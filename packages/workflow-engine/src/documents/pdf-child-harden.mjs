// Loaded first by the PDF reader child (pdf-child.mjs), before pdf.js: it takes away what the permission model leaves
// open to code running in the child. The console is silenced; the web network APIs are removed (the permission model
// covers sockets only from Node 25 on); and every process function that signals or debugs another process, changes
// identity or loads native code is removed (the permission model does not cover process._debugProcess, which sends
// SIGUSR1 to any pid and so would open the debugger of any Node process without --disable-sigusr1).

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
export const REMOVED_PROCESS_FUNCTIONS = [
  "kill",
  "_kill",
  "_debugProcess",
  "_debugEnd",
  "_startProfilerIdleNotifier",
  "_stopProfilerIdleNotifier",
  "execve",
  "setuid",
  "setgid",
  "seteuid",
  "setegid",
  "setgroups",
  "initgroups",
  "binding",
  "_linkedBinding",
  "dlopen"
];
for (const name of REMOVED_PROCESS_FUNCTIONS) {
  try {
    delete process[name];
  } catch {
    process[name] = undefined;
  }
}
