import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { useTheme } from '../context/useTheme.js'
import { createTheme, updateTheme, deleteTheme } from '../api/themes.js'
import apiClient from '../api/client.js'
import './AdminThemes.css'

const MAX_NAME_LENGTH = 255
const MAX_DESCRIPTION_LENGTH = 2000

const COLOR_FIELDS = [
  { key: 'color1', label: 'Border' },
  { key: 'color2', label: 'Background' },
  { key: 'color3', label: 'Text' },
  { key: 'color4', label: 'Heading Text' },
  { key: 'color5', label: 'Accent' },
]

const IMAGE_FIELDS = [
  { key: 'header', field: 'headerBackground', urlKey: 'headerBackgroundUrl', label: 'Header' },
  { key: 'sidebar', field: 'sidebarBackground', urlKey: 'sidebarBackgroundUrl', label: 'Sidebar' },
  { key: 'view', field: 'viewBackground', urlKey: 'viewBackgroundUrl', label: 'Background' },
]

function ColorField({ label, value, onChange }) {
  return (
    <div className="admin-themes-color-field">
      <label>{label}</label>
      <input
        type="color"
        value={`#${value || '000000'}`}
        onChange={(event) => onChange(event.target.value.slice(1).toUpperCase())}
      />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
        pattern="[0-9A-Fa-f]{6}"
        maxLength={6}
        required
      />
    </div>
  )
}

function ImageField({ label, currentUrl, file, removed, onFileChange, onToggleRemove }) {
  const inputRef = useRef(null)

  const objectUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => {
    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [objectUrl])

  const hasSavedImage = Boolean(currentUrl) && !removed
  const previewUrl = objectUrl ?? (hasSavedImage ? `${apiClient.defaults.baseURL}${currentUrl}` : null)

  return (
    <div className="admin-themes-image-field">
      <label>{label}</label>
      {previewUrl && <img src={previewUrl} alt="" className="admin-themes-image-preview" />}
      {!previewUrl && removed && (
        <p className="admin-themes-image-removed-note">Will be removed on save.</p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(event) => onFileChange(event.target.files?.[0] || null)}
      />
      <div className="admin-themes-image-actions">
        <button type="button" onClick={() => inputRef.current?.click()}>
          {previewUrl ? 'Replace' : 'Upload'}
        </button>
        {file && (
          <button type="button" onClick={() => onFileChange(null)}>
            Clear
          </button>
        )}
        {!file && hasSavedImage && (
          <button type="button" onClick={() => onToggleRemove(true)}>
            Remove
          </button>
        )}
        {!file && removed && (
          <button type="button" onClick={() => onToggleRemove(false)}>
            Undo
          </button>
        )}
      </div>
    </div>
  )
}

function AdminThemes() {
  const { user, loading: authLoading } = useAuth()
  const { success, error: toastError } = useToast()
  const navigate = useNavigate()
  const { id: themeId } = useParams()
  const isEditMode = Boolean(themeId)
  const { themes, loading: themesLoading, refreshThemes } = useTheme()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [colors, setColors] = useState({ color1: '', color2: '', color3: '', color4: '', color5: '' })
  const [isDefault, setIsDefault] = useState(false)
  const [existingImages, setExistingImages] = useState({})
  const [files, setFiles] = useState({ header: null, sidebar: null, view: null })
  const [removals, setRemovals] = useState({ header: false, sidebar: false, view: false })
  const [loaded, setLoaded] = useState(!isEditMode)
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    function populateFromTheme() {
      if (!isEditMode || themesLoading || loaded) {
        return
      }
      const target = themes.find((item) => String(item.id) === themeId)
      if (target) {
        setName(target.name)
        setDescription(target.description ?? '')
        setColors(target.colors)
        setIsDefault(target.isDefault)
        setExistingImages(target.images)
      }
      setLoaded(true)
    }
    populateFromTheme()
  }, [isEditMode, themesLoading, loaded, themes, themeId])

  if (authLoading) {
    return (
      <section className="settings-page">
        <p className="settings-status">Loading...</p>
      </section>
    )
  }

  if (!user || user.role !== 'admin') {
    return (
      <section className="settings-page">
        <p className="settings-status settings-status-error">
          You are not authorized to view this page.
        </p>
      </section>
    )
  }

  const targetTheme = isEditMode ? themes.find((item) => String(item.id) === themeId) : null

  if (isEditMode && loaded && !targetTheme) {
    return (
      <section className="settings-page">
        <p className="settings-status settings-status-error">Theme not found.</p>
      </section>
    )
  }

  function setColor(key, value) {
    setColors((prev) => ({ ...prev, [key]: value }))
  }

  function setFile(key, file) {
    setFiles((prev) => ({ ...prev, [key]: file }))
    if (file) {
      setRemovals((prev) => ({ ...prev, [key]: false }))
    }
  }

  function setRemoved(key, value) {
    setRemovals((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitting) {
      return
    }
    setSubmitting(true)
    try {
      const fields = {
        name: name.trim(),
        description: description.trim(),
        ...colors,
        system: true,
        isDefault,
      }
      for (const { key, field } of IMAGE_FIELDS) {
        if (files[key]) {
          fields[field] = files[key]
        } else if (removals[key]) {
          fields[`remove${field[0].toUpperCase()}${field.slice(1)}`] = true
        }
      }
      if (isEditMode) {
        await updateTheme(themeId, fields)
      } else {
        await createTheme(fields)
      }
      await refreshThemes()
      success(isEditMode ? 'Theme updated.' : 'Theme created.')
      navigate('/control-panel')
    } catch (err) {
      toastError(err.response?.data?.message || 'Failed to save theme.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    if (deleting) {
      return
    }
    if (!window.confirm(`Delete the theme "${name}"? This cannot be undone.`)) {
      return
    }
    setDeleting(true)
    try {
      await deleteTheme(themeId)
      await refreshThemes()
      success('Theme deleted.')
      navigate('/control-panel')
    } catch (err) {
      toastError(err.response?.data?.message || 'Failed to delete theme.')
      setDeleting(false)
    }
  }

  if (isEditMode && !loaded) {
    return (
      <section className="settings-page">
        <p className="settings-status">Loading...</p>
      </section>
    )
  }

  return (
    <section className="settings-page">
      <div className="settings-card">
        <h1>{isEditMode ? 'Edit Theme' : 'Create Theme'}</h1>

        <form className="settings-form" onSubmit={handleSubmit}>
          <label htmlFor="admin-theme-name">Name</label>
          <input
            id="admin-theme-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_NAME_LENGTH}
            required
            disabled={submitting}
          />

          <label htmlFor="admin-theme-description">Description</label>
          <textarea
            id="admin-theme-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={MAX_DESCRIPTION_LENGTH}
            rows={3}
            disabled={submitting}
          />

          <label>Colors</label>
          <div className="admin-themes-colors">
            {COLOR_FIELDS.map(({ key, label }) => (
              <ColorField key={key} label={label} value={colors[key]} onChange={(value) => setColor(key, value)} />
            ))}
          </div>

          <label className="admin-themes-checkbox">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
              disabled={submitting}
            />
            Default theme (sitewide fallback)
          </label>

          <label>Images</label>
          <div className="admin-themes-images">
            {IMAGE_FIELDS.map(({ key, urlKey, label }) => (
              <ImageField
                key={key}
                label={label}
                currentUrl={existingImages[urlKey]}
                file={files[key]}
                removed={removals[key]}
                onFileChange={(file) => setFile(key, file)}
                onToggleRemove={(value) => setRemoved(key, value)}
              />
            ))}
          </div>

          <button type="submit" className="settings-submit" disabled={submitting}>
            {submitting ? 'Saving...' : isEditMode ? 'Save Changes' : 'Create Theme'}
          </button>

          {isEditMode && (
            <button
              type="button"
              className="admin-themes-delete"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? 'Deleting...' : 'Delete Theme'}
            </button>
          )}
        </form>
      </div>
    </section>
  )
}

export default AdminThemes
