<script setup lang="ts">
// The A–Z glossary on /glossary/: a jump bar of letters, then every term with its definition.
import { withBase } from "vitepress";
import { data as terms } from "../data/glossary.data.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const letterOf = (term: string) => {
  const first = term.trim().charAt(0).toUpperCase();
  return LETTERS.includes(first) ? first : "#";
};
const groups = [...LETTERS, "#"]
  .map((letter) => ({ letter, terms: terms.filter((term) => letterOf(term.term) === letter) }))
  .filter((group) => group.terms.length > 0);
const present = new Set(groups.map((group) => group.letter));
const anchor = (letter: string) => (letter === "#" ? "terms-other" : `terms-${letter.toLowerCase()}`);
</script>

<template>
  <nav class="hub-az" aria-label="Glossary letters">
    <ul>
      <li v-for="letter in LETTERS" :key="letter">
        <a v-if="present.has(letter)" :href="`#${anchor(letter)}`">{{ letter }}</a>
        <span v-else class="hub-az-empty" aria-hidden="true">{{ letter }}</span>
      </li>
      <li v-if="present.has('#')"><a href="#terms-other" aria-label="Other terms">#</a></li>
    </ul>
  </nav>
  <p class="hub-count" role="status">{{ terms.length }} {{ terms.length === 1 ? "term" : "terms" }}</p>
  <section v-for="group in groups" :key="group.letter" class="hub-az-group" :aria-labelledby="anchor(group.letter)">
    <h2 :id="anchor(group.letter)" class="hub-az-letter">{{ group.letter }}</h2>
    <dl class="hub-terms">
      <div v-for="term in group.terms" :key="term.slug" class="hub-card hub-term-card">
        <dt><a :href="withBase(`/glossary/${term.slug}`)">{{ term.term }}</a></dt>
        <dd>{{ term.definition }}</dd>
      </div>
    </dl>
  </section>
</template>
