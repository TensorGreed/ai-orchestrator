<script setup lang="ts">
// The recipe cards on /recipes/, with tag filters. Every card is in the HTML, so without JavaScript
// all of them show; the filter buttons are toggle buttons and a status line reads out the count.
import { computed, ref } from "vue";
import { data as recipes } from "../data/recipes.data.js";
import RecipeCard from "./RecipeCard.vue";

const tags = [...new Set(recipes.flatMap((recipe) => recipe.tags))].sort((a, b) => a.localeCompare(b));
const active = ref<string | null>(null);
const shown = computed(() => (active.value ? recipes.filter((recipe) => recipe.tags.includes(active.value!)) : recipes));
const toggle = (tag: string | null) => {
  active.value = active.value === tag ? null : tag;
};
</script>

<template>
  <section class="hub-section" aria-labelledby="hub-recipes-title">
    <h2 id="hub-recipes-title" class="hub-section-title">All recipes</h2>
    <div v-if="tags.length > 1" class="hub-filters" role="group" aria-label="Filter recipes by tag">
      <button type="button" class="hub-filter" :aria-pressed="active === null" @click="toggle(null)">All</button>
      <button v-for="tag in tags" :key="tag" type="button" class="hub-filter" :aria-pressed="active === tag" @click="toggle(tag)">{{ tag }}</button>
    </div>
    <p class="hub-count" role="status" aria-live="polite">
      {{ shown.length }} {{ shown.length === 1 ? "recipe" : "recipes" }}<template v-if="active"> tagged “{{ active }}”</template>
    </p>
    <ul class="hub-grid">
      <li v-for="recipe in shown" :key="recipe.slug"><RecipeCard :recipe="recipe" /></li>
    </ul>
  </section>
</template>
