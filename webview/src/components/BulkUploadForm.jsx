import { useState } from 'react'
import { useToast } from '../context/useToast.js'
import BulkUploadCard from './BulkUploadCard.jsx'
import './BulkUploadForm.css'

const MEDIA_EXTENSION_PATTERN =
  /\.(mp4|mkv|mov|avi|webm|m4v|wmv|flv|mpg|mpeg|3gp|ogv|mp3|wav|m4a|aac|flac|ogg|oga|opus)$/i

function isMediaFile(file) {
  if (file.type) {
    return file.type.startsWith('video/') || file.type.startsWith('audio/')
  }
  return MEDIA_EXTENSION_PATTERN.test(file.name || '')
}

/**
 * The bulk-upload queue: a drag/drop surface spanning the full card list,
 * plus one condensed BulkUploadCard per queued file (always ending in one
 * empty trailing card, the current drop/click target for the next file).
 * @param {{
 *   cards: Array,
 *   visibilityOptions: Array<{ value: string, label: string }>,
 *   disabled: boolean,
 *   onAddFiles: (files: File[]) => void,
 *   onUpdateCard: (id: number, patch: object) => void,
 *   onRemoveCard: (id: number) => void,
 * }} props
 */
function BulkUploadForm({ cards, visibilityOptions, disabled, onAddFiles, onUpdateCard, onRemoveCard }) {
  const { error: toastError } = useToast()
  const [dragActive, setDragActive] = useState(false)

  const dropTargetId = cards.find((c) => c.file == null)?.id

  function acceptFiles(fileList) {
    const files = Array.from(fileList || [])
    const valid = files.filter(isMediaFile)
    const skipped = files.filter((f) => !isMediaFile(f))
    if (skipped.length > 0) {
      toastError(
        `Skipped ${skipped.map((f) => f.name).join(', ')} — only video/audio files are supported.`,
      )
    }
    if (valid.length > 0) {
      onAddFiles(valid)
    }
  }

  function handleDragOver(event) {
    event.preventDefault()
    if (!disabled) {
      setDragActive(true)
    }
  }

  function handleDragLeave() {
    setDragActive(false)
  }

  function handleDrop(event) {
    event.preventDefault()
    setDragActive(false)
    if (disabled) {
      return
    }
    acceptFiles(event.dataTransfer.files)
  }

  return (
    <div
      className={`bulk-upload-form${dragActive ? ' bulk-upload-form-drag-active' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {cards.map((card) => (
        <BulkUploadCard
          key={card.id}
          card={card}
          visibilityOptions={visibilityOptions}
          isDropTarget={dragActive && card.id === dropTargetId}
          disabled={disabled}
          onFileSelected={(id, file) => acceptFiles([file])}
          onChange={onUpdateCard}
          onRemove={onRemoveCard}
        />
      ))}
    </div>
  )
}

export default BulkUploadForm
