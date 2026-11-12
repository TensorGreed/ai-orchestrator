<script setup lang="ts">
// "Try it in the demo": opens a workflow in the live demo (and, with `recorded`, plays its recorded run).
//   <TryInDemo workflow="wf-mcp-agent-quickstart" recorded />
import { computed } from "vue";
import { demoHref } from "../hub.js";

const props = withDefaults(defineProps<{ workflow: string; recorded?: boolean; label?: string }>(), { recorded: false, label: "" });
const href = computed(() => demoHref(props.workflow, props.recorded));
</script>

<template>
  <aside class="hub-demo" aria-label="Try it in the live demo">
    <div class="hub-demo-text">
      <p class="hub-demo-title">Try it in the live demo</p>
      <p class="hub-demo-body">
        <slot>{{ label || (recorded ? "Open this workflow in the studio and watch a recorded run." : "Open this workflow in the studio and look around.") }}</slot>
        It runs in your browser, with no sign-up.
      </p>
    </div>
    <a class="hub-button" :href="href" target="_self">Open in the demo<span aria-hidden="true"> →</span></a>
  </aside>
</template>
