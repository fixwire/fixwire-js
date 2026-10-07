<script setup lang="ts">
const items = ref<string[] | undefined>(['socks'])

// An error in an event handler: Vue catches it, Fixwire reports it.
function checkout() {
  throw new Error('Checkout failed: the card was declined')
}

// The next render fails.
function emptyCart() {
  items.value = undefined
}

function count(list: string[] | undefined): number {
  if (!list) throw new TypeError('Cannot read the cart: items is undefined')
  return list.length
}
</script>

<template>
  <div>
    <h1>Shop</h1>
    <p>Each of these fails in its own way; Fixwire gets every one.</p>
    <button type="button" @click="checkout">Check out</button>
    <button type="button" @click="emptyCart">Empty the cart ({{ count(items) }})</button>
  </div>
</template>
