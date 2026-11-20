// The cookieless page-view counter (GoatCounter) for the lsquarem.com website: the landing and the docs.
// The L2M product and the live demo do not load this file and send no analytics.
// GoatCounter sets no cookies and keeps no personal data, so there is nothing to consent to and no banner. The privacy
// note on the landing and the docs says so.
// scripts/check-pages-site.mjs allows exactly these two hosts (gc.zgo.at, <code>.goatcounter.com), never on /demo/.
(function () {
  "use strict";
  // GoatCounter site code (the <code> of https://<code>.goatcounter.com). Empty: nothing is loaded or counted.
  var GOATCOUNTER_CODE = "lsquarem";

  // This site used Google Analytics behind a consent bar before; clear what an earlier Accept or Decline left behind
  // (the stored choice and the _ga, _ga_<id> cookies, on this host and the parent domain).
  function forgetOldAnalytics() {
    try {
      localStorage.removeItem("l2m-site-consent");
    } catch (e) {}
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
    var st = document.createElement("style");
    st.id = "site-consent-style";
    st.textContent =
      ".site-privacy-note{margin:0;padding:16px 24px 24px;text-align:center;font-size:13px;line-height:1.5;color:var(--vp-c-text-2,#4a5468)}" +
      ".site-privacy-note a{color:inherit;text-decoration:underline}";
    document.head.appendChild(st);
  }

  // Counts page views without cookies; the docs are a single-page app, so its in-page navigations count too.
  function startCounter() {
    if (!/^[a-z0-9-]{1,63}$/.test(GOATCOUNTER_CODE)) return;
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://gc.zgo.at/count.js";
    s.setAttribute("data-goatcounter", "https://" + GOATCOUNTER_CODE + ".goatcounter.com/count");
    document.head.appendChild(s);
    var last = location.pathname + location.search;
    function count() {
      var path = location.pathname + location.search;
      if (path === last || !window.goatcounter || !window.goatcounter.count) return;
      last = path;
      window.goatcounter.count({ path: path });
    }
    var push = history.pushState;
    history.pushState = function () {
      push.apply(this, arguments);
      setTimeout(count, 0);
    };
    window.addEventListener("popstate", count);
  }

  forgetOldAnalytics();
  injectStyle();
  startCounter();
})();
