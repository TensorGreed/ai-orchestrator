<script setup lang="ts">
// One recipe as a card: title, what it does, tags, node count and whether it opens in the demo.
import { withBase } from "vitepress";
import type { RecipeSummary } from "../data/recipes.data.js";

defineProps<{ recipe: RecipeSummary; headingLevel?: 2 | 3 }>();
</script>

<template>
  <article class="hub-card hub-recipe-card">
    <component :is="`h${headingLevel ?? 3}`" class="hub-card-title">
      <a class="hub-card-link" :href="withBase(`/recipes/${recipe.slug}`)">{{ recipe.title }}</a>
    </component>
    <p class="hub-card-text">{{ recipe.description }}</p>
    <p class="hub-card-meta">
      <span>{{ recipe.nodeCount }} nodes</span>
      <span v-if="recipe.demo" class="hub-badge">Opens in the demo</span>
    </p>
    <ul class="hub-tags" aria-label="Tags">
      <li v-for="tag in recipe.tags" :key="tag">{{ tag }}</li>
    </ul>
  </article>
</template>
