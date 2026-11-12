<script setup lang="ts">
// The header above a Learn guide's title: its track and place in it, level, reading time and last update.
import { computed } from "vue";
import { useData, withBase } from "vitepress";
import { LEVEL_LABELS, trackPositionOf, type Level } from "../../site/tracks.js";
import { formatDate, isoDay } from "../hub.js";

const { page, frontmatter } = useData();
const slug = computed(() => page.value.relativePath.replace(/^learn\//, "").replace(/\.md$/, ""));
const position = computed(() => trackPositionOf(slug.value));
const level = computed(() => LEVEL_LABELS[frontmatter.value.level as Level] ?? "");
const minutes = computed(() => (page.value as { readingMinutes?: number }).readingMinutes ?? 0);
const updated = computed(() => page.value.lastUpdated ?? 0);
</script>

<template>
  <div class="hub-meta" role="group" aria-label="About this guide">
    <span v-if="position" class="hub-meta-item">
      <a class="hub-meta-track" :href="withBase(`/learn/#track-${position.track.id}`)">{{ position.track.title }}</a>
      <span class="hub-meta-faint">· Guide {{ position.index + 1 }} of {{ position.track.pages.length }}</span>
    </span>
    <span v-if="level" class="hub-level" :data-level="frontmatter.level">{{ level }}</span>
    <span v-if="minutes" class="hub-meta-item">{{ minutes }} min read</span>
    <span v-if="updated" class="hub-meta-item">Updated <time :datetime="isoDay(updated)">{{ formatDate(updated) }}</time></span>
  </div>
</template>
