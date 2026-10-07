import { createApp } from 'vue'
import * as Fixwire from '@fixwire/vue'
import App from './App.vue'
import router from './router'

const app = createApp(App)

app.use(router)

// Before mount, so errors from the first render are reported too.
Fixwire.init({
  app,
  router,
  dsn: import.meta.env.VITE_FIXWIRE_DSN,
  release: import.meta.env.VITE_FIXWIRE_RELEASE,
  tracesSampleRate: 1,
})

app.mount('#app')
