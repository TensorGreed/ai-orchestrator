// The default theme, with the small overrides in custom.css and the website privacy note.
import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "layout-bottom": () =>
        h("p", { class: "site-privacy-note" }, [
          "This website (not the L2M product) uses Google Analytics, only after you accept cookies. ",
          h("a", { href: "#", "data-cookie-settings": "" }, "Cookie settings")
        ])
    });
  }
};
