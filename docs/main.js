// Mobile menu, theme toggle, year stamp and scroll-reveal.

const menuToggle = document.getElementById("menuToggle");
const siteNav = document.getElementById("siteNav");
const yearTarget = document.getElementById("year");
const themeToggle = document.getElementById("themeToggle");

if (yearTarget) {
  yearTarget.textContent = String(new Date().getFullYear());
}

if (menuToggle && siteNav) {
  const setOpen = (open) => {
    siteNav.classList.toggle("open", open);
    menuToggle.setAttribute("aria-expanded", String(open));
    menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };

  menuToggle.addEventListener("click", () => {
    const open = !siteNav.classList.contains("open");
    setOpen(open);
    if (open) siteNav.querySelector("a")?.focus();
  });

  siteNav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => setOpen(false));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && siteNav.classList.contains("open")) {
      setOpen(false);
      menuToggle.focus();
    }
  });
}

// The initial theme is set by an inline script in <head> to avoid a flash of
// the wrong theme; the toggle persists the choice when storage is available.
if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("l2m-theme", next);
    } catch (e) {
      // Storage unavailable (private browsing, blocked site data): the toggle still works for this page.
    }
  });
}

// Sections fade in as they scroll into view. Without IntersectionObserver, or
// with reduced motion requested, they are shown at once.
document.documentElement.classList.add("js");
const revealTargets = document.querySelectorAll(".reveal");
const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!("IntersectionObserver" in window) || reduceMotion) {
  revealTargets.forEach((item) => item.classList.add("is-visible"));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.08, rootMargin: "0px 0px -40px 0px" }
  );
  revealTargets.forEach((item) => observer.observe(item));
}
