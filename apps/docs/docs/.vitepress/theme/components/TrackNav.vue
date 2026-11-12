<script setup lang="ts">
// "Next in this track" (and previous) at the end of a Learn guide. After the last published guide
// of a track it hands over to the next track, as set in .vitepress/site/tracks.ts.
import { computed } from "vue";
import { useData, withBase } from "vitepress";
import { trackPositionOf } from "../../site/tracks.js";
import { data as guides } from "../data/learn.data.js";
import { pageExists } from "../hub.js";

const { page } = useData();
const position = computed(() => trackPositionOf(page.value.relativePath, pageExists));
const titleOf = (path: string) => guides.find((guide) => guide.path === path)?.title ?? "";
const previous = computed(() => (position.value?.previous ? { path: position.value.previous, title: titleOf(position.value.previous) } : null));
const next = computed(() => {
  const step = position.value?.next;
  if (!step) return null;
  const title = titleOf(step.path);
  if (title) return { path: step.path, title, dir: step.label ? `Next track: ${step.label}` : "Next in this track" };
  if (step.path === "/learn/") return { path: step.path, title: "Choose another track", dir: "End of this track" };
  if (step.path === "/recipes/") return { path: step.path, title: "Try a recipe", dir: "End of this track" };
  return { path: step.path, title: "Keep going", dir: "End of this track" };
});
const trackHref = computed(() => {
  const track = position.value?.track;
  if (!track) return "";
  return withBase(pageExists(`/learn/${track.id}/`) ? `/learn/${track.id}/` : `/learn/#track-${track.id}`);
});
</script>

<template>
  <nav v-if="position" class="hub-track-nav" :aria-label="`Next steps in ${position.track.title}`">
    <p class="hub-track-nav-title">
      <span>Track:</span>
      <a :href="trackHref">{{ position.track.title }}</a>
    </p>
    <div class="hub-track-nav-links">
      <a v-if="previous" class="hub-track-nav-link" :href="withBase(previous.path)" rel="prev">
        <span class="hub-track-nav-dir">Previous in this track</span>
        <span class="hub-track-nav-name">{{ previous.title }}</span>
      </a>
      <a v-if="next" class="hub-track-nav-link is-next" :href="withBase(next.path)" :rel="position.nextLeavesTrack ? undefined : 'next'">
        <span class="hub-track-nav-dir">{{ next.dir }}</span>
        <span class="hub-track-nav-name">{{ next.title }}</span>
      </a>
    </div>
  </nav>
</template>
