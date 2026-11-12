<script setup lang="ts">
// Under every doc page of the knowledge hub (the doc-after slot, so it shows even on a page with no
// "last updated" date or pager): the demo call-out (frontmatter `demo`), on glossary terms the guide
// that explains the term (frontmatter `guide`), related glossary terms (frontmatter `related`) and,
// on Learn guides, next / previous in the track.
import { computed } from "vue";
import { useData } from "vitepress";
import { pageKindOf } from "../../site/sections.js";
import RelatedTerms from "./RelatedTerms.vue";
import TermGuide from "./TermGuide.vue";
import TrackNav from "./TrackNav.vue";
import TryInDemo from "./TryInDemo.vue";

const { page, frontmatter } = useData();
const kind = computed(() => pageKindOf(page.value.relativePath));
const demo = computed(() => (kind.value === "learn" || kind.value === "post") && typeof frontmatter.value.demo === "string" ? (frontmatter.value.demo as string) : "");
</script>

<template>
  <div v-if="kind === 'learn' || kind === 'glossary' || kind === 'recipe' || kind === 'post'" class="hub-doc-footer">
    <TryInDemo v-if="demo" :workflow="demo" :recorded="frontmatter.demoRecorded === true" />
    <TermGuide v-if="kind === 'glossary'" />
    <RelatedTerms />
    <TrackNav v-if="kind === 'learn'" />
  </div>
</template>
