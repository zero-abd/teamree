// Baked in by electron.vite.config.ts. `app.getVersion()` is unreliable because
// it reports Electron's version whenever the app runs unpackaged.
declare const __APP_VERSION__: string

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev'
