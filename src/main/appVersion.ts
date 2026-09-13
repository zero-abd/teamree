// Baked in by electron.vite.config.ts. `app.getVersion()` is unreliable because
// it reports Electron's version whenever the app runs unpackaged.
declare const __APP_VERSION__: string

/**
 * What a build that was never built reports.
 *
 * `npm run dev` has no `__APP_VERSION__` to bake in, so this is what the app
 * says about itself in a checkout. It is named rather than repeated because the
 * update check has to recognise it: it parses as a pre-release of 0.0.0, which
 * every published release is newer than, so a developer would be told to
 * upgrade on every launch of every dev server.
 */
export const DEV_VERSION = '0.0.0-dev'

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : DEV_VERSION
