import type { ServerConfig } from '@fixwire/nuxt'

// Options for the server that nuxt.config can't hold: functions.
export default {
  beforeSend(event) {
    event.tags = { ...event.tags, side: 'server' }
    return event
  },
} satisfies ServerConfig
