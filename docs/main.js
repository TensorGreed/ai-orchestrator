const menuToggle = document.getElementById("menuToggle");
const siteNav = document.getElementById("siteNav");
const yearTarget = document.getElementById("year");

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

const revealTargets = document.querySelectorAll(".reveal");
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
      }
    });
  },
  { threshold: 0.16, rootMargin: "0px 0px -40px 0px" }
);

revealTargets.forEach((item) => observer.observe(item));
