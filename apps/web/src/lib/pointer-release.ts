/**
 * Runs a callback once the pointer is released. A field that collapses its helpers on blur would otherwise shift the
 * layout between the mouse press that blurred it and the release, so the click lands on whatever moved under the
 * pointer instead of what the user pressed (an "Advanced" toggle needed a second click).
 */

let pointerDown = false;
let tracking = false;

function track(): void {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener("pointerdown", () => (pointerDown = true), true);
  document.addEventListener("pointerup", () => (pointerDown = false), true);
  document.addEventListener("pointercancel", () => (pointerDown = false), true);
}

if (typeof document !== "undefined") track();

export function runAfterPointerRelease(fn: () => void): void {
  track();
  if (!pointerDown || typeof document === "undefined") {
    fn();
    return;
  }
  const done = () => {
    document.removeEventListener("pointerup", done, true);
    document.removeEventListener("pointercancel", done, true);
    // After the click that follows the release.
    window.setTimeout(fn, 0);
  };
  document.addEventListener("pointerup", done, true);
  document.addEventListener("pointercancel", done, true);
}
