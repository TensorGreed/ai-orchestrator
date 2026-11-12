<script setup lang="ts">
// A track's index page (learn/<track>/index.md): its published guides in order, with reading time.
//   <TrackGuides track="agents" />
import { computed } from "vue";
import { withBase } from "vitepress";
import { LEVEL_LABELS, trackById } from "../../site/tracks.js";
import { data as guides } from "../data/learn.data.js";

const props = defineProps<{ track: string }>();
const track = computed(() => trackById(props.track));
const items = computed(() =>
  (track.value?.pages ?? []).map((slug) => guides.find((guide) => guide.path === `/learn/${props.track}/${slug}`)).filter((guide) => guide !== undefined)
);
if (import.meta.env.SSR && !trackById(props.track)) console.warn(`[learn] <TrackGuides track="${props.track}"> names no track in .vitepress/site/tracks.ts`);
</script>

<template>
  <section v-if="track" class="hub-section" aria-labelledby="hub-track-guides-title">
    <h2 id="hub-track-guides-title" class="hub-section-title">Guides in this track</h2>
    <p class="hub-card-meta hub-track-summary">
      <span class="hub-level" :data-level="track.level">{{ LEVEL_LABELS[track.level] }}</span>
      <span>{{ items.length }} {{ items.length === 1 ? "guide" : "guides" }}, in reading order</span>
    </p>
    <ol class="hub-start">
      <li v-for="(guide, index) in items" :key="guide.path" class="hub-start-step">
        <span class="hub-start-number" aria-hidden="true">{{ index + 1 }}</span>
        <div>
          <a class="hub-start-link" :href="withBase(guide.path)">{{ guide.title }}</a>
          <p class="hub-card-text">{{ guide.description }}</p>
          <p class="hub-card-meta">{{ guide.readingMinutes }} min read</p>
        </div>
      </li>
    </ol>
  </section>
</template>
