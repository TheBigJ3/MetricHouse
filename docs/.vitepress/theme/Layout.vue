<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import MhLockup from './components/MhLockup.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <!-- The name and the mark, above the home page headline. -->
    <template #home-hero-info-before>
      <MhLockup />
    </template>
  </Layout>
</template>
