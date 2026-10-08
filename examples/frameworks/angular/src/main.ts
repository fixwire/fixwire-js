import { bootstrapApplication } from '@angular/platform-browser';
import * as Fixwire from '@fixwire/angular';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Set at build time: ng build --define 'FIXWIRE_DSN="https://<key>@<ingest host>"'
declare const FIXWIRE_DSN: string | undefined;

// Before bootstrap, so errors while the app starts are reported too.
Fixwire.init({
  dsn: typeof FIXWIRE_DSN === 'string' ? FIXWIRE_DSN : undefined,
  tracesSampleRate: 1,
});

bootstrapApplication(App, appConfig).catch((err) => Fixwire.captureException(err));
