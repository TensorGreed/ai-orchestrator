<script setup lang="ts">
// Above every doc page's title: breadcrumbs, then the guide or post header where the page has one.
import { computed } from "vue";
import { useData } from "vitepress";
import { pageKindOf } from "../../site/sections.js";
import GuideHeader from "./GuideHeader.vue";
import HubBreadcrumbs from "./HubBreadcrumbs.vue";
import PostHeader from "./PostHeader.vue";

const { page } = useData();
const kind = computed(() => pageKindOf(page.value.relativePath));
</script>

<template>
  <HubBreadcrumbs />
  <GuideHeader v-if="kind === 'learn'" />
  <PostHeader v-else-if="kind === 'post'" />
</template>
