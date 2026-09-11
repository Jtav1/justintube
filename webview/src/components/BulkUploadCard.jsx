import { UploadCloud, X } from 'lucide-react'
import ProgressBar from './ProgressBar.jsx'
import './BulkUploadCard.css'

/**
 * One condensed row in the bulk-upload queue: a single-line file selector,
 * a title field, and a visibility field. The file field locks once
 * populated (discard via the X to change it); title/visibility stay
 * editable until the card starts uploading.
 * @param {{
 *   card: { id: number, file: File|null, title: string, visibility: string, status: string, progress: number, error: string|null },
 *   visibilityOptions: Array<{ value: string, label: string }>,
 *   isDropTarget: boolean,
 *   disabled: boolean,
 *   onFileSelected: (id: number, file: File) => void,
 *   onChange: (id: number, patch: object) => void,
 *   onRemove: (id: number) => void,
 * }} props
 */
function BulkUploadCard({ card, visibilityOptions, isDropTarget, disabled, onFileSelected, onChange, onRemove }) {
  const { id, file, title, visibility, status, progress, error } = card
  const fileLocked = file != null
  const fieldsDisabled = disabled || status === 'uploading' || status === 'success'

  function handleFileInputChange(event) {
    const selected = event.target.files?.[0]
    event.target.value = ''
    if (selected) {
      onFileSelected(id, selected)
    }
  }

  return (
    <div
      className={`bulk-upload-card${isDropTarget ? ' bulk-upload-card-drop-target' : ''}${status === 'error' ? ' bulk-upload-card-error' : ''}`}
    >
      {fileLocked && (
        <button
          type="button"
          className="bulk-upload-card-remove"
          onClick={() => onRemove(id)}
          disabled={disabled || status === 'uploading'}
          aria-label={`Discard ${file.name}`}
          title={`Discard ${file.name}`}
        >
          <X size={14} />
        </button>
      )}

      <div className="bulk-upload-card-row">
        <label
          className={`bulk-upload-card-file${fileLocked ? ' bulk-upload-card-file-locked' : ''}`}
        >
          <UploadCloud size={16} />
          <span>{file ? file.name : 'Choose or drop a file'}</span>
          {!fileLocked && (
            <input
              type="file"
              accept="video/*,audio/*"
              className="bulk-upload-card-file-input"
              onChange={handleFileInputChange}
              disabled={disabled}
            />
          )}
        </label>

        <input
          type="text"
          className="bulk-upload-card-title"
          value={title}
          onChange={(event) => onChange(id, { title: event.target.value })}
          placeholder="Title"
          disabled={fieldsDisabled}
          aria-label="Title"
        />

        <select
          className="bulk-upload-card-visibility"
          value={visibility}
          onChange={(event) => onChange(id, { visibility: event.target.value })}
          disabled={fieldsDisabled}
          aria-label="Visibility"
        >
          {visibilityOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {status === 'uploading' && (
        <ProgressBar value={progress} label={`Uploading (${progress}%)...`} />
      )}
      {status === 'error' && <p className="bulk-upload-card-error-text">{error}</p>}
      {status === 'success' && <p className="bulk-upload-card-success-text">Uploaded</p>}
    </div>
  )
}

export default BulkUploadCard
