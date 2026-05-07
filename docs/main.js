// Mobile menu, theme toggle, year stamp, and scroll-reveal.

const menuToggle = document.getElementById("menuToggle");
const siteNav = document.getElementById("siteNav");
const yearTarget = document.getElementById("year");
const themeToggle = document.getElementById("themeToggle");

if (yearTarget) {
  yearTarget.textContent = String(new Date().getFullYear());
}

if (menuToggle && siteNav) {
  menuToggle.addEventListener("click", () => {
    const next = !siteNav.classList.contains("open");
    siteNav.classList.toggle("open", next);
    menuToggle.setAttribute("aria-expanded", String(next));
  });

  siteNav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      siteNav.classList.remove("open");
      menuToggle.setAttribute("aria-expanded", "false");
    });
  });
}

// Theme toggle persists to localStorage. The initial theme is set by an
// inline script in <head> to avoid a flash-of-wrong-theme on page load.
if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("l2m-theme", next);
    } catch (e) {
      // Storage unavailable (private browsing, etc.) — toggle still works for the session.
    }
  });
}

const revealTargets = document.querySelectorAll(".reveal");
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
      }
    });
  },
  { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
);
revealTargets.forEach((item) => observer.observe(item));
