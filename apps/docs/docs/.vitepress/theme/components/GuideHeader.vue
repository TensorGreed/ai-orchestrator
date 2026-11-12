<script setup lang="ts">
// The header above a Learn guide's title: its track and place in it, level, reading time and last update.
import { computed } from "vue";
import { useData, withBase } from "vitepress";
import { LEVEL_LABELS, trackPositionOf, type Level } from "../../site/tracks.js";
import { formatDate, isoDay, pageExists } from "../hub.js";

const { page, frontmatter } = useData();
const position = computed(() => trackPositionOf(page.value.relativePath, pageExists));
const level = computed(() => LEVEL_LABELS[frontmatter.value.level as Level] ?? "");
const minutes = computed(() => (page.value as { readingMinutes?: number }).readingMinutes ?? 0);
const updated = computed(() => page.value.lastUpdated ?? 0);
const trackHref = computed(() => {
  const track = position.value?.track;
  if (!track) return "";
  return withBase(pageExists(`/learn/${track.id}/`) ? `/learn/${track.id}/` : `/learn/#track-${track.id}`);
});
</script>

<template>
  <div class="hub-meta" role="group" aria-label="About this guide">
    <span v-if="position" class="hub-meta-item">
      <a class="hub-meta-track" :href="trackHref">{{ position.track.title }}</a>
      <span class="hub-meta-faint">· Guide {{ position.index + 1 }} of {{ position.published.length }}</span>
    </span>
    <span v-if="level" class="hub-level" :data-level="frontmatter.level">{{ level }}</span>
    <span v-if="minutes" class="hub-meta-item">{{ minutes }} min read</span>
    <span v-if="updated" class="hub-meta-item">Updated <time :datetime="isoDay(updated)">{{ formatDate(updated) }}</time></span>
  </div>
</template>
