<script setup lang="ts">
// "Previous / next in this track" at the end of a Learn guide.
import { computed } from "vue";
import { useData, withBase } from "vitepress";
import { trackPositionOf } from "../../site/tracks.js";
import { data as guides } from "../data/learn.data.js";

const { page } = useData();
const position = computed(() => trackPositionOf(page.value.relativePath.replace(/^learn\//, "").replace(/\.md$/, "")));
const guide = (slug: string | null) => (slug ? guides.find((item) => item.slug === slug) ?? null : null);
const previous = computed(() => guide(position.value?.previous ?? null));
const next = computed(() => guide(position.value?.next ?? null));
</script>

<template>
  <nav v-if="position" class="hub-track-nav" :aria-label="`More in ${position.track.title}`">
    <p class="hub-track-nav-title">
      <span>More in</span>
      <a :href="withBase(`/learn/#track-${position.track.id}`)">{{ position.track.title }}</a>
    </p>
    <div class="hub-track-nav-links">
      <a v-if="previous" class="hub-track-nav-link" :href="withBase(`/learn/${previous.slug}`)" rel="prev">
        <span class="hub-track-nav-dir">Previous in track</span>
        <span class="hub-track-nav-name">{{ previous.title }}</span>
      </a>
      <a v-if="next" class="hub-track-nav-link is-next" :href="withBase(`/learn/${next.slug}`)" rel="next">
        <span class="hub-track-nav-dir">Next in track</span>
        <span class="hub-track-nav-name">{{ next.title }}</span>
      </a>
      <a v-if="!next" class="hub-track-nav-link is-next" :href="withBase('/learn/')">
        <span class="hub-track-nav-dir">End of this track</span>
        <span class="hub-track-nav-name">Choose your next track</span>
      </a>
    </div>
  </nav>
</template>
