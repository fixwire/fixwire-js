import { fixwireSvelteKit } from '@fixwire/sveltekit/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// Source maps for fixwire-cli, not referenced from the files: they're
	// uploaded, then deleted (npm run sourcemaps).
	build: { sourcemap: 'hidden' },
	plugins: [
		// Debug ids in the client build, before the adapter copies and lists it.
		fixwireSvelteKit(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	]
});
