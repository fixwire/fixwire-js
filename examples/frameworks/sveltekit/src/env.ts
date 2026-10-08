import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_FIXWIRE_DSN: {
		public: true,
		// Optional: without it, Fixwire stays off.
		schema: (value) => value,
		description: 'Your Fixwire project DSN: https://<publishable key>@<ingest host>'
	}
});
