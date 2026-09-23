export function PaneCloseButton({ name, onClose }: { name: string; onClose: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="pane__close"
      title="Close pane"
      aria-label={`Close pane ${name}`}
      onClick={onClose}
    >
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M3 3 L9 9 M9 3 L3 9" />
      </svg>
    </button>
  )
}
