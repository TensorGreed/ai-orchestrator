<script setup lang="ts">
// The A–Z glossary on /glossary/: topic filters, a jump bar of letters, then every term with its
// definition. Terms with a page link to it; index-only terms (site/glossary-entries.ts) carry their
// definition here, an anchor (/glossary/#<slug>) and, when L2M has the feature, an "In L2M" link. Every term is in the HTML, so without JavaScript all of them show; the filters are
// toggle buttons and a status line reads out the count.
import { computed, ref } from "vue";
import { withBase } from "vitepress";
import { GLOSSARY_TOPICS } from "../../site/taxonomy.js";
import { data as terms } from "../data/glossary.data.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const topics = GLOSSARY_TOPICS.filter((topic) => terms.some((term) => term.topic === topic.id));
const active = ref<string | null>(null);
const shown = computed(() => (active.value ? terms.filter((term) => term.topic === active.value) : terms));
const letterOf = (term: string) => {
  const first = term.trim().charAt(0).toUpperCase();
  return LETTERS.includes(first) ? first : "#";
};
const groups = computed(() =>
  [...LETTERS, "#"].map((letter) => ({ letter, terms: shown.value.filter((term) => letterOf(term.term) === letter) })).filter((group) => group.terms.length > 0)
);
const present = computed(() => new Set(groups.value.map((group) => group.letter)));
const anchor = (letter: string) => (letter === "#" ? "terms-other" : `terms-${letter.toLowerCase()}`);
const topicLabel = computed(() => GLOSSARY_TOPICS.find((topic) => topic.id === active.value)?.label ?? "");
const toggle = (topic: string | null) => {
  active.value = active.value === topic ? null : topic;
};
</script>

<template>
  <div v-if="topics.length > 1" class="hub-filters" role="group" aria-label="Filter terms by topic">
    <button type="button" class="hub-filter" :aria-pressed="active === null" @click="toggle(null)">All topics</button>
    <button v-for="topic in topics" :key="topic.id" type="button" class="hub-filter" :aria-pressed="active === topic.id" @click="toggle(topic.id)">{{ topic.label }}</button>
  </div>
  <nav class="hub-az" aria-label="Glossary letters">
    <ul>
      <li v-for="letter in LETTERS" :key="letter">
        <a v-if="present.has(letter)" :href="`#${anchor(letter)}`">{{ letter }}</a>
        <span v-else class="hub-az-empty" aria-hidden="true">{{ letter }}</span>
      </li>
      <li v-if="present.has('#')"><a href="#terms-other" aria-label="Other terms">#</a></li>
    </ul>
  </nav>
  <p class="hub-count" role="status" aria-live="polite">
    {{ shown.length }} {{ shown.length === 1 ? "term" : "terms" }}<template v-if="active"> in {{ topicLabel }}</template>
  </p>
  <section v-for="group in groups" :key="group.letter" class="hub-az-group" :aria-labelledby="anchor(group.letter)">
    <h2 :id="anchor(group.letter)" class="hub-az-letter">{{ group.letter }}</h2>
    <dl class="hub-terms">
      <div v-for="term in group.terms" :id="term.slug" :key="term.slug" class="hub-card hub-term-card" :class="{ 'is-entry': !term.hasPage }">
        <dt>
          <a v-if="term.hasPage" :href="withBase(term.href)">{{ term.term }}</a>
          <template v-else>{{ term.term }}</template>
        </dt>
        <dd>
          {{ term.definition }}
          <a v-if="term.docs" class="hub-term-docs" :href="withBase(term.docs)">In L2M<span class="visually-hidden">: {{ term.term }}</span><span aria-hidden="true"> →</span></a>
        </dd>
      </div>
    </dl>
  </section>
</template>
