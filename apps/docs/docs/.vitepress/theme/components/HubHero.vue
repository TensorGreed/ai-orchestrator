<script setup lang="ts">
// The top of a knowledge-hub section index: eyebrow, the page's one <h1>, a lead and optional links.
//   <HubHero eyebrow="Learn" title="Learn MCP agents, one track at a time" lead="…" />
defineProps<{ eyebrow: string; title: string; lead: string }>();
</script>

<template>
  <header class="hub-hero">
    <p class="hub-eyebrow">{{ eyebrow }}</p>
    <h1 class="hub-hero-title">{{ title }}</h1>
    <p class="hub-hero-lead">{{ lead }}</p>
    <div v-if="$slots.default" class="hub-hero-actions"><slot /></div>
  </header>
</template>
