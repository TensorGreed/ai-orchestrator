<script setup lang="ts">
// The tracks on /learn/: one card per track with its guides in reading order.
import { withBase } from "vitepress";
import { LEVEL_LABELS, TRACKS } from "../../site/tracks.js";
import { data as guides } from "../data/learn.data.js";

const tracks = TRACKS.map((track) => {
  const items = track.pages.map((slug) => guides.find((guide) => guide.slug === slug)).filter((guide) => guide !== undefined);
  return { ...track, items, minutes: items.reduce((sum, guide) => sum + guide.readingMinutes, 0) };
}).filter((track) => track.items.length > 0);
</script>

<template>
  <section class="hub-section" aria-labelledby="hub-tracks-title">
    <h2 id="hub-tracks-title" class="hub-section-title">Tracks</h2>
    <ol class="hub-tracks">
      <li v-for="(track, index) in tracks" :id="`track-${track.id}`" :key="track.id" class="hub-card hub-track">
        <div class="hub-track-head">
          <span class="hub-track-number" aria-hidden="true">{{ String(index + 1).padStart(2, "0") }}</span>
          <div>
            <h3 class="hub-card-title">{{ track.title }}</h3>
            <p class="hub-card-meta">
              <span class="hub-level" :data-level="track.level">{{ LEVEL_LABELS[track.level] }}</span>
              <span>{{ track.items.length }} {{ track.items.length === 1 ? "guide" : "guides" }} · about {{ track.minutes }} min</span>
            </p>
          </div>
        </div>
        <p class="hub-card-text">{{ track.summary }}</p>
        <ol class="hub-track-guides">
          <li v-for="guide in track.items" :key="guide.slug">
            <a :href="withBase(`/learn/${guide.slug}`)">{{ guide.title }}</a>
            <span class="hub-track-guide-desc">{{ guide.description }}</span>
          </li>
        </ol>
        <a class="hub-button hub-button-quiet" :href="withBase(`/learn/${track.items[0].slug}`)">Start the track<span class="visually-hidden">: {{ track.title }}</span><span aria-hidden="true"> →</span></a>
      </li>
    </ol>
  </section>
</template>
