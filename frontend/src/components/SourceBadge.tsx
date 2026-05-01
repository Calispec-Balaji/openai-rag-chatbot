interface Props {
  name: string
}

export default function SourceBadge({ name }: Props) {
  return (
    <span className="source-badge" title={name}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM6 20V4h5v7h7v9H6z" />
      </svg>
      {name}
    </span>
  )
}
