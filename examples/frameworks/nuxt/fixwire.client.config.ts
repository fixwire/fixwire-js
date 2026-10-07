import type { ClientConfig } from '@fixwire/nuxt'

// Options for the browser that nuxt.config can't hold: functions.
export default {
  beforeSend(event) {
    event.tags = { ...event.tags, side: 'browser' }
    return event
  },
} satisfies ClientConfig
