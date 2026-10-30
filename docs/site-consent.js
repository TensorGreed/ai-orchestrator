// Cookie consent for the lsquarem.com website (landing and docs) with Google Consent Mode v2.
// The L2M product and the live demo do not load this file and send no analytics.
// Nothing is requested from Google until the visitor accepts: gtag.js is injected on Accept
// (or on a later visit when Accept was stored). Only analytics_storage is ever granted.
(function () {
  "use strict";
  var GA_ID = "G-J3CBSHR723";
  var KEY = "l2m-site-consent";
  var bar = null;
  var loaded = false;

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }

  // Consent Mode v2: everything denied until the visitor decides.
  gtag("consent", "default", {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied"
  });

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "granted" || v === "denied" ? v : null;
    } catch (e) {
      return null;
    }
  }

  function write(value) {
    try {
      localStorage.setItem(KEY, value);
    } catch (e) {}
  }

  function loadAnalytics() {
    if (loaded) return;
    loaded = true;
    gtag("js", new Date());
    gtag("config", GA_ID);
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
    document.head.appendChild(s);
  }

  function grant() {
    gtag("consent", "update", { analytics_storage: "granted" });
    loadAnalytics();
  }

  function revoke() {
    // Stop collecting; if gtag.js was loaded earlier in this page view, tell it so.
    if (loaded) gtag("consent", "update", { analytics_storage: "denied" });
    // Remove Google Analytics cookies left by an earlier Accept (_ga, _ga_<id>), on this host and the parent domain.
    var host = location.hostname;
    var domains = ["", host, "." + host.split(".").slice(-2).join(".")];
    document.cookie.split(";").forEach(function (part) {
      var name = part.split("=")[0].trim();
      if (name !== "_ga" && name.indexOf("_ga_") !== 0) return;
      domains.forEach(function (d) {
        document.cookie = name + "=; Max-Age=0; path=/" + (d ? "; domain=" + d : "");
      });
    });
  }

  function injectStyle() {
    if (document.getElementById("site-consent-style")) return;
    var css =
      ".site-consent{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;justify-content:center;padding:12px 16px;pointer-events:none;font:400 14px/1.45 Inter,system-ui,-apple-system,'Segoe UI',sans-serif}" +
      ".site-consent[hidden]{display:none}" +
      ".site-consent-box{pointer-events:auto;display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;max-width:760px;width:100%;box-sizing:border-box;padding:12px 16px;border:1px solid var(--line-strong,var(--vp-c-divider,#c4cbd9));border-radius:12px;background:var(--bg-elev,var(--vp-c-bg-elv,#fff));color:var(--fg,var(--vp-c-text-1,#0d1220));box-shadow:var(--shadow-lg,0 12px 40px rgba(0,0,0,.25))}" +
      ".site-consent-text{flex:1 1 280px;margin:0;color:var(--fg-muted,var(--vp-c-text-2,#4a5468))}" +
      ".site-consent-text a{color:var(--accent,var(--vp-c-brand-1,#0a7ea4));text-decoration:underline}" +
      ".site-consent-actions{display:flex;gap:8px}" +
      ".site-consent button{font:inherit;font-weight:600;min-height:38px;padding:7px 16px;border-radius:8px;cursor:pointer;border:1px solid var(--line-strong,var(--vp-c-divider,#c4cbd9));background:transparent;color:var(--fg,var(--vp-c-text-1,#0d1220))}" +
      ".site-consent button:hover{background:var(--accent-soft,var(--vp-c-default-soft,rgba(10,126,164,.1)))}" +
      ".site-consent button:focus-visible{outline:2px solid var(--accent,var(--vp-c-brand-1,#0a7ea4));outline-offset:2px}" +
      ".site-privacy-note{margin:0;padding:16px 24px 24px;text-align:center;font-size:13px;line-height:1.5;color:var(--vp-c-text-2,#4a5468)}" +
      ".site-privacy-note a,.site-privacy-note button{color:inherit;text-decoration:underline}" +
      ".site-privacy-note button{font:inherit;background:none;border:0;padding:0;cursor:pointer}";
    var st = document.createElement("style");
    st.id = "site-consent-style";
    st.textContent = css;
    document.head.appendChild(st);
  }

  function build() {
    injectStyle();
    bar = document.createElement("div");
    bar.className = "site-consent";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Cookie consent");
    bar.hidden = true;
    bar.innerHTML =
      '<div class="site-consent-box">' +
      '<p class="site-consent-text" id="site-consent-text">This website (not the L2M product) uses Google Analytics to count visits, but only if you accept.</p>' +
      '<div class="site-consent-actions">' +
      '<button type="button" class="site-consent-decline">Decline</button>' +
      '<button type="button" class="site-consent-accept">Accept</button>' +
      "</div></div>";
    bar.querySelector(".site-consent-accept").addEventListener("click", function () {
      write("granted");
      grant();
      hide();
    });
    bar.querySelector(".site-consent-decline").addEventListener("click", function () {
      write("denied");
      revoke();
      hide();
    });
    bar.addEventListener("keydown", function (e) {
      if (e.key === "Escape") hide();
    });
    document.body.appendChild(bar);
  }

  // `focus` only when the visitor reopened the bar; on page load it must not take keyboard focus.
  function show(focus) {
    if (!bar) build();
    bar.hidden = false;
    var target = focus && bar.querySelector(".site-consent-decline");
    if (target) target.focus({ preventScroll: true });
  }

  function hide() {
    if (bar) bar.hidden = true;
  }

  // Any element with [data-cookie-settings] reopens the bar (footer links on every page).
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-cookie-settings]") : null;
    if (!el) return;
    e.preventDefault();
    show(true);
  });

  var saved = read();
  if (saved === "granted") grant();

  function init() {
    if (saved === null) show();
  }
  if (document.body) init();
  else document.addEventListener("DOMContentLoaded", init);
})();
