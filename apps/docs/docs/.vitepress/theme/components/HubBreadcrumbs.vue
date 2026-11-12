<script setup lang="ts">
// The page's breadcrumb trail (computed in the config, the same trail as its BreadcrumbList JSON-LD).
import { computed } from "vue";
import { useData } from "vitepress";
import { hubSectionOf, type Crumb } from "../../site/sections.js";
import { sitePath } from "../hub.js";

const { page } = useData();
const crumbs = computed(() => ((page.value as { breadcrumbs?: Crumb[] }).breadcrumbs ?? []) as Crumb[]);
// Hub pages always show their trail; a docs page only when it has more than Docs › page.
const visible = computed(() => crumbs.value.length >= (hubSectionOf(page.value.relativePath) ? 2 : 3));
</script>

<template>
  <nav v-if="visible" class="hub-breadcrumbs" aria-label="Breadcrumb">
    <ol>
      <li v-for="(crumb, index) in crumbs" :key="crumb.url">
        <svg v-if="index > 0" class="hub-breadcrumbs-sep" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <a v-if="index < crumbs.length - 1" :href="sitePath(crumb.url)">{{ crumb.name }}</a>
        <span v-else aria-current="page">{{ crumb.name }}</span>
      </li>
    </ol>
  </nav>
</template>
