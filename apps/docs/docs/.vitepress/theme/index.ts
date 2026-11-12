// The default theme, with the small overrides in custom.css, the website privacy note, and the
// knowledge hub: breadcrumbs and guide/post headers above each page, demo call-outs, related terms
// and track navigation below it, and the components the hub's Markdown pages use.
import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import { h } from "vue";
import BlogIndex from "./components/BlogIndex.vue";
import GlossaryIndex from "./components/GlossaryIndex.vue";
import HubDocBefore from "./components/HubDocBefore.vue";
import HubDocFooter from "./components/HubDocFooter.vue";
import HubHero from "./components/HubHero.vue";
import LearnTracks from "./components/LearnTracks.vue";
import RecipeCard from "./components/RecipeCard.vue";
import RecipeGrid from "./components/RecipeGrid.vue";
import RelatedTerms from "./components/RelatedTerms.vue";
import Term from "./components/Term.vue";
import TryInDemo from "./components/TryInDemo.vue";
import "./custom.css";
import "./hub.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "doc-before": () => h(HubDocBefore),
      "doc-footer-before": () => h(HubDocFooter),
      "layout-bottom": () =>
        h("p", { class: "site-privacy-note" }, [
          "This website (not the L2M product) uses Google Analytics, only after you accept cookies. ",
          h("a", { href: "#", "data-cookie-settings": "" }, "Cookie settings")
        ])
    });
  },
  enhanceApp({ app }) {
    for (const [name, component] of Object.entries({ BlogIndex, GlossaryIndex, HubHero, LearnTracks, RecipeCard, RecipeGrid, RelatedTerms, Term, TryInDemo })) {
      app.component(name, component);
    }
  }
} satisfies Theme;
