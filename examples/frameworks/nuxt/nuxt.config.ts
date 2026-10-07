// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@fixwire/nuxt'],
  // The DSN comes from NUXT_PUBLIC_FIXWIRE_DSN when the server starts.
  fixwire: {
    tracesSampleRate: 1,
  },
  // Source maps for the browser code, for fixwire-cli; not referenced from
  // the files, and deleted once uploaded (npm run sourcemaps).
  sourcemap: { client: 'hidden' },
})
