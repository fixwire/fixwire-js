/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Your project's DSN: https://<publishable key>@<ingest host> */
  readonly VITE_FIXWIRE_DSN?: string
  readonly VITE_FIXWIRE_RELEASE?: string
}
