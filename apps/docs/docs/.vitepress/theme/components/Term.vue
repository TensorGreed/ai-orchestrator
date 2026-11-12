<script setup lang="ts">
// A glossary term in running text: a link to its glossary page, with its one-line definition as a
// tooltip on hover and keyboard focus. Escape hides it either way (WCAG 1.4.13): while the pointer is
// over the term a document listener catches the key, since focus may be elsewhere.
//   <Term id="agent-loop">agent loops</Term>
import { computed, onBeforeUnmount, ref, useId } from "vue";
import { withBase } from "vitepress";
import { data as terms } from "../data/glossary.data.js";

const props = defineProps<{ id: string }>();
const term = computed(() => terms.find((item) => item.slug === props.id) ?? null);
const tipId = `term-tip-${useId()}`;
const dismissed = ref(false);
const onEscape = (event: KeyboardEvent) => {
  if (event.key === "Escape") dismissed.value = true;
};
const hoverStart = () => document.addEventListener("keydown", onEscape);
const hoverEnd = () => {
  document.removeEventListener("keydown", onEscape);
  dismissed.value = false;
};
onBeforeUnmount(() => {
  if (typeof document !== "undefined") document.removeEventListener("keydown", onEscape);
});
if (import.meta.env.SSR && !terms.some((item) => item.slug === props.id)) {
  console.warn(`[glossary] <Term id="${props.id}"> names no glossary/${props.id}.md; it renders as plain text`);
}
</script>

<template>
  <span v-if="term" class="hub-term" :class="{ 'is-dismissed': dismissed }" @mouseenter="hoverStart" @mouseleave="hoverEnd" @keydown.esc="dismissed = true">
    <a class="hub-term-link" :href="withBase(term.href)" :aria-describedby="tipId" @blur="dismissed = false"><slot>{{ term.term }}</slot></a>
    <span :id="tipId" class="hub-term-tip" role="tooltip"><strong>{{ term.term }}:</strong> {{ term.definition }}</span>
  </span>
  <span v-else><slot /></span>
</template>
