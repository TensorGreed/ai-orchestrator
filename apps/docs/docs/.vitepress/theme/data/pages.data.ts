// The docs path of every published page (`/learn/agents/what-is-an-ai-agent`, `/learn/`), so the
// theme can skip links to pages that are not written yet (planned Learn guides, start-here steps).
import { createContentLoader } from "vitepress";

declare const data: string[];
export { data };

export default createContentLoader("**/*.md", {
  transform(raw): string[] {
    return raw.map((page) => page.url.replace(/^\/docs\//, "/").replace(/\.html$/, "")).sort();
  }
});
