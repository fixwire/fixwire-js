<template>
  <div>
    <NuxtRouteAnnouncer />
    <nav>
      <NuxtLink to="/">Shop</NuxtLink>
      <NuxtLink to="/users/1">User 1</NuxtLink>
      <a href="/users/crash">A page that fails</a>
      <a href="/api/orders/7">An API route that fails</a>
    </nav>
    <main>
      <NuxtPage />
    </main>
  </div>
</template>

<style scoped>
nav {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
}
</style>
