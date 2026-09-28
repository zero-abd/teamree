import { Icon } from '../icons/Icon'
export function PaneCloseButton({ name, onClose }: { name: string; onClose: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="pane__close"
      data-tip="Close pane"
      aria-label={`Close pane ${name}`}
      onClick={onClose}
    >
      <Icon name="close" size={14} />
    </button>
  )
}
