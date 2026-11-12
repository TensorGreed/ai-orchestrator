<script setup lang="ts">
// /learn/: the start-here path, then one card per track with its published guides in reading order.
// Tracks with no published guide yet are left out.
import { withBase } from "vitepress";
import { LEVEL_LABELS, START_HERE, TRACKS } from "../../site/tracks.js";
import { data as guides } from "../data/learn.data.js";
import { data as recipes } from "../data/recipes.data.js";
import { pageExists } from "../hub.js";

const byPath = new Map(guides.map((guide) => [guide.path, guide]));
const tracks = TRACKS.map((track) => {
  const items = track.pages.map((slug) => byPath.get(`/learn/${track.id}/${slug}`)).filter((guide) => guide !== undefined);
  return { ...track, items, minutes: items.reduce((sum, guide) => sum + guide.readingMinutes, 0), hasIndex: pageExists(`/learn/${track.id}/`) };
}).filter((track) => track.items.length > 0);

const startHere = START_HERE.filter(pageExists).map((path) => {
  const guide = byPath.get(path);
  if (guide) return { path, title: guide.title, kind: "Guide", description: guide.description };
  const recipe = recipes.find((item) => `/recipes/${item.slug}` === path);
  return { path, title: recipe?.title ?? path, kind: "Recipe", description: recipe?.description ?? "" };
});
</script>

<template>
  <section v-if="startHere.length > 0" class="hub-section" aria-labelledby="hub-start-title">
    <h2 id="hub-start-title" class="hub-section-title">Start here</h2>
    <ol class="hub-start">
      <li v-for="(step, index) in startHere" :key="step.path" class="hub-start-step">
        <span class="hub-start-number" aria-hidden="true">{{ index + 1 }}</span>
        <div>
          <span class="hub-start-kind">{{ step.kind }}</span>
          <a class="hub-start-link" :href="withBase(step.path)">{{ step.title }}</a>
          <p class="hub-card-text">{{ step.description }}</p>
        </div>
      </li>
    </ol>
  </section>

  <section class="hub-section" aria-labelledby="hub-tracks-title">
    <h2 id="hub-tracks-title" class="hub-section-title">Tracks</h2>
    <ol class="hub-tracks">
      <li v-for="(track, index) in tracks" :id="`track-${track.id}`" :key="track.id" class="hub-card hub-track">
        <div class="hub-track-head">
          <span class="hub-track-number" aria-hidden="true">{{ String(index + 1).padStart(2, "0") }}</span>
          <div>
            <h3 class="hub-card-title">
              <a v-if="track.hasIndex" class="hub-plain-link" :href="withBase(`/learn/${track.id}/`)">{{ track.title }}</a>
              <template v-else>{{ track.title }}</template>
            </h3>
            <p class="hub-card-meta">
              <span class="hub-level" :data-level="track.level">{{ LEVEL_LABELS[track.level] }}</span>
              <span>{{ track.items.length }} {{ track.items.length === 1 ? "guide" : "guides" }} · about {{ track.minutes }} min</span>
            </p>
          </div>
        </div>
        <p class="hub-card-text">{{ track.summary }}</p>
        <ol class="hub-track-guides">
          <li v-for="guide in track.items" :key="guide.path">
            <a :href="withBase(guide.path)">{{ guide.title }}</a>
            <span class="hub-track-guide-desc">{{ guide.description }}</span>
          </li>
        </ol>
        <a class="hub-button hub-button-quiet" :href="withBase(track.items[0].path)">Start the track<span class="visually-hidden">: {{ track.title }}</span><span aria-hidden="true"> →</span></a>
      </li>
    </ol>
  </section>
</template>
