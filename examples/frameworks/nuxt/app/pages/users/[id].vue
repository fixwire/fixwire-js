<script setup lang="ts">
const route = useRoute()
const id = computed(() => String(route.params.id))

// Rendered on the server first: an error here is reported from the server,
// named after the route `/users/:id`.
if (id.value === 'crash') throw new Error('The user service is unavailable')
</script>

<template>
  <h1>User {{ id }}</h1>
</template>
