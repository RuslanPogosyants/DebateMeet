import './rooms-panel-toggle.css'

export function RoomsPanelToggle({
  expanded,
  controls,
  onToggle,
}: {
  expanded: boolean
  controls: string
  onToggle: () => void
}) {
  const label = expanded ? 'Свернуть боковую панель' : 'Показать боковую панель'
  return (
    <button
      className="action icon-control rooms-panel-toggle"
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
        <path d={expanded ? 'm16 9-3 3 3 3' : 'm13 9 3 3-3 3'} />
      </svg>
    </button>
  )
}
