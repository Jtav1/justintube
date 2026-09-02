import './SegmentedProgressBar.css'

/**
 * A horizontal progress bar split into colored segments (e.g. one per job
 * kind), sized proportionally to each segment's value, with an optional
 * legend row underneath listing each non-zero segment's color, label, and
 * count. Renders a flat empty track + status message when every segment is
 * zero.
 * @param {{
 *   segments: Array<{key: string, value: number, color: string, label: string}>,
 *   emptyLabel?: string,
 *   showLegend?: boolean,
 * }} props
 */
function SegmentedProgressBar({ segments, emptyLabel = 'Nothing to show.', showLegend = true }) {
  const nonZero = segments.filter((segment) => segment.value > 0)
  const total = nonZero.reduce((sum, segment) => sum + segment.value, 0)
  const trackLabel =
    total === 0 ? emptyLabel : nonZero.map((s) => `${s.label}: ${s.value}`).join(', ')

  return (
    <div className="segmented-progress-bar">
      <div className="segmented-progress-bar-track" role="img" aria-label={trackLabel}>
        {total === 0 ? (
          <div className="segmented-progress-bar-empty" />
        ) : (
          nonZero.map((segment) => (
            <div
              key={segment.key}
              className="segmented-progress-bar-segment"
              style={{ width: `${(segment.value / total) * 100}%`, backgroundColor: segment.color }}
            />
          ))
        )}
      </div>
      {total === 0 && <p className="segmented-progress-bar-status">{emptyLabel}</p>}
      {total > 0 && showLegend && (
        <ul className="segmented-progress-bar-legend">
          {nonZero.map((segment) => (
            <li key={segment.key} className="segmented-progress-bar-legend-item">
              <span className="segmented-progress-bar-swatch" style={{ backgroundColor: segment.color }} />
              {segment.label} ({segment.value})
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default SegmentedProgressBar
