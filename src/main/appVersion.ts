// Baked in by electron.vite.config.ts. `app.getVersion()` is unreliable because
// it reports Electron's version whenever the app runs unpackaged.
declare const __APP_VERSION__: string

/**
 * What `npm run dev` reports. Named because the update check has to recognise
 * it: every published release is newer than a pre-release of 0.0.0.
 */
export const DEV_VERSION = '0.0.0-dev'

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : DEV_VERSION
