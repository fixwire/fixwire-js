<script lang="ts">
	let items = $state<string[] | undefined>(['socks']);

	// An error in an event handler: the browser SDK reports it.
	function checkout() {
		throw new Error('Checkout failed: the card was declined');
	}

	function count(list: string[] | undefined): number {
		if (!list) throw new TypeError('Cannot read the cart: items is undefined');
		return list.length;
	}
</script>

<h1>Shop</h1>
<p>Each of these fails in its own way; Fixwire gets every one.</p>
<button type="button" onclick={checkout}>Check out</button>
<!-- The next render fails. -->
<button type="button" onclick={() => (items = undefined)}>Empty the cart ({count(items)})</button>
