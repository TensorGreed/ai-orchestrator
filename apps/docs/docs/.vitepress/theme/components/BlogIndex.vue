<script setup lang="ts">
// The posts on /blog/, newest first and grouped by year. With no posts it says so and points at the feed.
import { withBase } from "vitepress";
import { data as posts } from "../data/blog.data.js";
import { formatDate } from "../hub.js";

const years = [...new Set(posts.map((post) => post.date.slice(0, 4)))].map((year) => ({ year, posts: posts.filter((post) => post.date.startsWith(year)) }));
</script>

<template>
  <section class="hub-section" aria-labelledby="hub-posts-title">
    <h2 id="hub-posts-title" class="hub-section-title">Posts</h2>
    <div v-if="posts.length === 0" class="hub-card hub-empty">
      <p>There are no posts yet. Follow the <a :href="withBase('/blog/feed.xml')">Atom feed</a> to hear about the first one, or read the <a :href="withBase('/learn/')">Learn guides</a> in the meantime.</p>
    </div>
    <div v-for="group in years" :key="group.year" class="hub-year">
      <h3 class="hub-year-title">{{ group.year }}</h3>
      <ol class="hub-posts">
        <li v-for="post in group.posts" :key="post.slug" class="hub-post">
          <time class="hub-post-date" :datetime="post.date">{{ formatDate(post.date) }}</time>
          <div>
            <a class="hub-post-title" :href="withBase(`/blog/${post.slug}`)">{{ post.title }}</a>
            <p class="hub-post-desc">{{ post.description }}</p>
            <p class="hub-post-author">By {{ post.author }}</p>
          </div>
        </li>
      </ol>
    </div>
  </section>
</template>
