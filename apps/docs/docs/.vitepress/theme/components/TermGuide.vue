<script setup lang="ts">
// Under a glossary term: the Learn guide that explains the term in depth. The page's `guide`
// frontmatter lists docs paths in order of preference (`/learn/mcp/what-is-mcp`); the first one that
// is published is shown, so a term can name a guide before it is written.
import { computed } from "vue";
import { useData, withBase } from "vitepress";
import { data as guides } from "../data/learn.data.js";

const { frontmatter } = useData();
const guide = computed(() => {
  const raw = frontmatter.value.guide;
  const wanted = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).map((path) => String(path).replace(/\/$/, ""));
  for (const path of wanted) {
    const found = guides.find((item) => item.path === path);
    if (found) return found;
  }
  return null;
});
</script>

<template>
  <aside v-if="guide" class="hub-term-guide" aria-label="Guide">
    <p class="hub-term-guide-label">Explained in depth</p>
    <a class="hub-term-guide-link" :href="withBase(guide.path)">{{ guide.title }}</a>
    <p class="hub-term-guide-desc">{{ guide.description }}</p>
  </aside>
</template>
