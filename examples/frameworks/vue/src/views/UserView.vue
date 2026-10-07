<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const id = computed(() => String(route.params.id))

// The page fails while it's set up: reported with the route `/users/:id`.
if (id.value === 'crash') throw new Error('The user service is unavailable')
</script>

<template>
  <h1>User {{ id }}</h1>
</template>
