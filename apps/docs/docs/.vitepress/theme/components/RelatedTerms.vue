<script setup lang="ts">
// A box of related glossary terms with their definitions. Defaults to the page's `related` frontmatter.
//   <RelatedTerms :terms="['agent-loop', 'tool-call']" />
import { computed } from "vue";
import { useData, withBase } from "vitepress";
import { data as glossary } from "../data/glossary.data.js";

const props = defineProps<{ terms?: string[] }>();
const { frontmatter, page } = useData();
const self = computed(() => page.value.relativePath.replace(/^glossary\//, "").replace(/\.md$/, ""));
const items = computed(() => {
  const wanted = props.terms ?? (Array.isArray(frontmatter.value.related) ? (frontmatter.value.related as string[]) : []);
  return wanted.filter((slug) => slug !== self.value).map((slug) => glossary.find((term) => term.slug === slug)).filter((term) => term !== undefined);
});
if (import.meta.env.SSR) {
  const wanted = props.terms ?? [];
  for (const slug of wanted) if (!glossary.some((term) => term.slug === slug)) console.warn(`[glossary] related term "${slug}" has no glossary page`);
}
</script>

<template>
  <aside v-if="items.length > 0" class="hub-related" aria-label="Related terms">
    <h2 class="hub-related-title">Related terms</h2>
    <ul>
      <li v-for="term in items" :key="term.slug">
        <a :href="withBase(`/glossary/${term.slug}`)">{{ term.term }}</a>
        <span class="hub-related-def">{{ term.definition }}</span>
      </li>
    </ul>
  </aside>
</template>
