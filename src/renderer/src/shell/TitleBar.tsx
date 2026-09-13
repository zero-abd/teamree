// The window's title strip. It carries the wordmark and, more importantly, it is
// the window's drag region: with the native title bar hidden on macOS there is
// nothing else to grab the window by.

import { titleBarClassName } from './titleBarClass'

export function TitleBar({ platform }: { platform: string | undefined }): React.JSX.Element {
  return (
    <header className={titleBarClassName(platform)}>
      <span className="wordmark">
        teamree
        <span className="wordmark__dot" aria-hidden="true" />
      </span>
    </header>
  )
}
