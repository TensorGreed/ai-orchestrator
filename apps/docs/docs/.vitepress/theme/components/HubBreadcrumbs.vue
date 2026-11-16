<script setup lang="ts">
// The page's breadcrumb trail (computed in the config, the same trail as its BreadcrumbList JSON-LD).
import { computed } from "vue";
import { useData } from "vitepress";
import { SITE, type Crumb } from "../../site/sections.js";
import { sitePath } from "../hub.js";

const { page } = useData();
const trail = computed(() => ((page.value as { breadcrumbs?: Crumb[] }).breadcrumbs ?? []) as Crumb[]);
// Every page but the docs home shows its trail, starting at the landing ("L2M"), so the visible
// trail is exactly the page's BreadcrumbList JSON-LD (structured data should describe what the page shows).
const visible = computed(() => trail.value.length >= 2);
const crumbs = computed(() => [{ name: "L2M", url: `${SITE}/` }, ...trail.value]);
</script>

<template>
  <nav v-if="visible" class="hub-breadcrumbs" aria-label="Breadcrumb">
    <ol>
      <li v-for="(crumb, index) in crumbs" :key="crumb.url">
        <svg v-if="index > 0" class="hub-breadcrumbs-sep" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <!-- The landing is outside the docs app: a full page load, not a client-side route. -->
        <a v-if="index === 0" :href="crumb.url" target="_self">{{ crumb.name }}</a>
        <a v-else-if="index < crumbs.length - 1" :href="sitePath(crumb.url)">{{ crumb.name }}</a>
        <span v-else aria-current="page">{{ crumb.name }}</span>
      </li>
    </ol>
  </nav>
</template>
