<script setup lang="ts"></script>

<template>
  <nav>
    <RouterLink to="/">Shop</RouterLink>
    <RouterLink to="/users/1">User 1</RouterLink>
    <RouterLink to="/users/crash">A page that fails</RouterLink>
    <RouterLink to="/reports">Reports</RouterLink>
  </nav>
  <main>
    <RouterView :key="$route.fullPath" />
  </main>
</template>

<style scoped>
nav {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
}
</style>
