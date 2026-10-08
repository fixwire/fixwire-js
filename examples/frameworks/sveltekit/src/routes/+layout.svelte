<script lang="ts">
	import * as Fixwire from '@fixwire/sveltekit';
	import { afterNavigate } from '$app/navigation';
	import favicon from '#lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Pages named after their routes (`/users/[id]`) in traces and errors.
	afterNavigate(Fixwire.trackNavigation);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Fixwire with SvelteKit</title>
</svelte:head>

<nav>
	<a href="/">Shop</a>
	<a href="/users/1">User 1</a>
	<a href="/users/crash" data-sveltekit-reload>A page that fails</a>
	<a href="/reports">Reports</a>
</nav>

<main>
	{@render children()}
</main>

<style>
	nav {
		display: flex;
		gap: 1rem;
		margin-bottom: 1rem;
	}
</style>
