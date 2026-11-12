<script setup lang="ts">
// The header above a blog post's title: date, author and reading time.
import { computed } from "vue";
import { useData } from "vitepress";
import { formatDate, isoDay } from "../hub.js";

const { page, frontmatter } = useData();
const date = computed(() => {
  const value = frontmatter.value.date as unknown;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10);
});
const minutes = computed(() => (page.value as { readingMinutes?: number }).readingMinutes ?? 0);
</script>

<template>
  <div class="hub-meta" role="group" aria-label="About this post">
    <span class="hub-meta-item"><time :datetime="isoDay(date)">{{ formatDate(date) }}</time></span>
    <span class="hub-meta-item">
      By
      <a v-if="frontmatter.authorUrl" :href="frontmatter.authorUrl" rel="author noopener">{{ frontmatter.author }}</a>
      <span v-else>{{ frontmatter.author }}</span>
    </span>
    <span v-if="minutes" class="hub-meta-item">{{ minutes }} min read</span>
  </div>
</template>
