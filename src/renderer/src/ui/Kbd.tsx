// Keys as caps, for the palette, menus, Help and the welcome's short list only.

export function Kbd({ keys, label }: { keys: readonly string[]; label?: string }): React.JSX.Element {
  return (
    <span className="kbd-group" aria-label={label}>
      {keys.map((key, index) => (
        <kbd key={`${index}${key}`} className="kbd">
          {key}
        </kbd>
      ))}
    </span>
  )
}
