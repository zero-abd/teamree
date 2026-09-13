// Electron refuses to start as root on Linux unless the sandbox is switched
// off. The refusal is in C++, in PreSandboxStartup, so it fires before the main
// script is evaluated: the switch has to reach Electron's own command line and
// cannot be set from inside the app.
//
// The condition is deliberately narrow rather than "always pass --no-sandbox".
// Root is how container images usually run, which is where this matters; a
// developer's desktop and a GitHub-hosted runner are not root and keep the
// sandbox they are entitled to.
export function electronSandboxArgs() {
  const root = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
  return root ? ['--no-sandbox'] : []
}
