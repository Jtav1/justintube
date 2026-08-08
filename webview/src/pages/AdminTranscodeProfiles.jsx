import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import {
  getTranscodeProfiles,
  getTranscodeHardwareStatus,
  createTranscodeProfile,
  updateTranscodeProfile,
  deleteTranscodeProfile,
} from '../api/transcode-profiles.js'
import './AdminThemes.css'
import './AdminTranscodeProfiles.css'

const RESOLUTION_VALUES = ['240p', '360p', '480p', '720p', '1080p', '2kHD', '4kHD']
const RESOLUTION_DIMENSIONS = {
  '240p': { width: 426, height: 240 },
  '360p': { width: 640, height: 360 },
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '2kHD': { width: 2560, height: 1440 },
  '4kHD': { width: 3840, height: 2160 },
}
const MEDIA_TYPE_VALUES = ['video', 'audio']
const CONTAINER_OPTIONS = ['mp4', 'webm']
const VIDEO_CODEC_OPTIONS = ['h264', 'h265', 'vp9', 'vp8', 'av1']
const AUDIO_CODEC_OPTIONS = ['aac', 'opus', 'mp3', 'vorbis', 'flac']

const MAX_DESCRIPTION_LENGTH = 250
const MAX_TOKEN_LENGTH = 32
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

const CUSTOM_OPTION = '__custom__'

/**
 * A dropdown of curated values with an "Other" escape hatch that reveals a
 * free-text input, for fields the server only validates as a safe token
 * (outputContainer/videoCodec/audioCodec) rather than a fixed enum.
 */
function SelectOrCustom({ id, label, options, value, onChange, disabled }) {
  const isCustom = value !== '' && !options.includes(value)
  const selectValue = isCustom ? CUSTOM_OPTION : value

  return (
    <div className="admin-profiles-select-or-custom">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={selectValue}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value
          onChange(next === CUSTOM_OPTION ? '' : next)
        }}
      >
        <option value="" disabled>
          Select {label.toLowerCase()}...
        </option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
        <option value={CUSTOM_OPTION}>Other...</option>
      </select>
      {selectValue === CUSTOM_OPTION && (
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={MAX_TOKEN_LENGTH}
          pattern={SAFE_TOKEN_PATTERN.source}
          placeholder="Custom ffmpeg token"
          disabled={disabled}
          required
        />
      )}
    </div>
  )
}

function AdminTranscodeProfiles() {
  const { user, loading: authLoading } = useAuth()
  const { success, error: toastError } = useToast()
  const navigate = useNavigate()
  const { id: profileId } = useParams()
  const isEditMode = Boolean(profileId)

  const [profiles, setProfiles] = useState([])
  const [profilesLoading, setProfilesLoading] = useState(true)

  const [description, setDescription] = useState('')
  const [resolutionName, setResolutionName] = useState('')
  const [mediaType, setMediaType] = useState('video')
  const [outputHeight, setOutputHeight] = useState('')
  const [outputWidth, setOutputWidth] = useState('')
  const [outputContainer, setOutputContainer] = useState('')
  const [videoCodec, setVideoCodec] = useState('')
  const [audioCodec, setAudioCodec] = useState('')
  const [hardwareAccelerated, setHardwareAccelerated] = useState(false)

  const [hwStatus, setHwStatus] = useState({ available: false, enabled: false, encoders: [] })

  const [loaded, setLoaded] = useState(!isEditMode)
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function loadProfiles() {
      try {
        const data = await getTranscodeProfiles()
        if (!cancelled) {
          setProfiles(data.items)
        }
      } catch {
        if (!cancelled) {
          toastError('Failed to load transcoding profiles.')
        }
      } finally {
        if (!cancelled) {
          setProfilesLoading(false)
        }
      }
    }
    loadProfiles()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadHardwareStatus() {
      try {
        const data = await getTranscodeHardwareStatus()
        if (!cancelled) {
          setHwStatus(data)
        }
      } catch {
        // Advisory only - form still works with the hardware toggle disabled.
      }
    }
    loadHardwareStatus()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    function populateFromProfile() {
      if (!isEditMode || profilesLoading || loaded) {
        return
      }
      const target = profiles.find((item) => String(item.id) === profileId)
      if (target) {
        setDescription(target.description ?? '')
        setResolutionName(target.resolutionName)
        setMediaType(target.mediaType)
        setOutputHeight(String(target.outputHeight))
        setOutputWidth(String(target.outputWidth))
        setOutputContainer(target.outputContainer)
        setVideoCodec(target.videoCodec)
        setAudioCodec(target.audioCodec)
        setHardwareAccelerated(Boolean(target.hardwareAccelerated))
      }
      setLoaded(true)
    }
    populateFromProfile()
  }, [isEditMode, profilesLoading, loaded, profiles, profileId])

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

  const targetProfile = isEditMode ? profiles.find((item) => String(item.id) === profileId) : null

  if (isEditMode && loaded && !targetProfile) {
    return (
      <section className="settings-page">
        <p className="settings-status settings-status-error">Transcoding profile not found.</p>
      </section>
    )
  }

  if (isEditMode && !loaded) {
    return (
      <section className="settings-page">
        <p className="settings-status">Loading...</p>
      </section>
    )
  }

  function handleResolutionChange(nextResolutionName) {
    setResolutionName(nextResolutionName)
    const dimensions = RESOLUTION_DIMENSIONS[nextResolutionName]
    if (dimensions) {
      setOutputWidth(String(dimensions.width))
      setOutputHeight(String(dimensions.height))
    }
  }

  function handleSwapDimensions() {
    setOutputWidth(outputHeight)
    setOutputHeight(outputWidth)
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitting) {
      return
    }

    for (const [fieldValue, fieldLabel] of [
      [outputContainer, 'Output container'],
      [videoCodec, 'Video codec'],
      [audioCodec, 'Audio codec'],
    ]) {
      if (!SAFE_TOKEN_PATTERN.test(fieldValue)) {
        toastError(`${fieldLabel} must be a valid token (letters, numbers, ".", "_", "+", "-").`)
        return
      }
    }

    setSubmitting(true)
    try {
      const fields = {
        description: description.trim() || null,
        resolutionName,
        mediaType,
        outputHeight: Number(outputHeight),
        outputWidth: Number(outputWidth),
        outputContainer: outputContainer.trim(),
        videoCodec: videoCodec.trim(),
        audioCodec: audioCodec.trim(),
        hardwareAccelerated,
      }
      if (isEditMode) {
        await updateTranscodeProfile(profileId, fields)
      } else {
        await createTranscodeProfile(fields)
      }
      success(isEditMode ? 'Transcoding profile updated.' : 'Transcoding profile created.')
      navigate('/control-panel')
    } catch (err) {
      toastError(err.response?.data?.message || 'Failed to save transcoding profile.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    if (deleting) {
      return
    }
    if (!window.confirm(`Delete the transcoding profile "${resolutionName} (${mediaType})"? This cannot be undone.`)) {
      return
    }
    setDeleting(true)
    try {
      await deleteTranscodeProfile(profileId)
      success('Transcoding profile deleted.')
      navigate('/control-panel')
    } catch (err) {
      toastError(err.response?.data?.message || 'Failed to delete transcoding profile.')
      setDeleting(false)
    }
  }

  return (
    <section className="settings-page">
      <div className="settings-card">
        <h1>{isEditMode ? 'Edit Transcoding Profile' : 'Create Transcoding Profile'}</h1>

        <form className="settings-form" onSubmit={handleSubmit}>
          <label htmlFor="admin-profile-description">Description</label>
          <input
            id="admin-profile-description"
            type="text"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={MAX_DESCRIPTION_LENGTH}
            disabled={submitting}
          />

          <label htmlFor="admin-profile-resolution">
            Resolution <span className="required-mark" aria-hidden="true">*</span>
          </label>
          <select
            id="admin-profile-resolution"
            value={resolutionName}
            onChange={(event) => handleResolutionChange(event.target.value)}
            required
            disabled={submitting}
          >
            <option value="" disabled>
              Select resolution...
            </option>
            {RESOLUTION_VALUES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>

          <label htmlFor="admin-profile-media-type">
            Media Type <span className="required-mark" aria-hidden="true">*</span>
          </label>
          <select
            id="admin-profile-media-type"
            value={mediaType}
            onChange={(event) => setMediaType(event.target.value)}
            required
            disabled={submitting}
          >
            {MEDIA_TYPE_VALUES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>

          <label>
            Output Dimensions <span className="required-mark" aria-hidden="true">*</span>
          </label>
          <div className="admin-profiles-dimensions">
            <div>
              <label htmlFor="admin-profile-width">Width (px)</label>
              <input
                id="admin-profile-width"
                type="number"
                min="1"
                step="1"
                value={outputWidth}
                onChange={(event) => setOutputWidth(event.target.value)}
                required
                disabled={submitting}
              />
            </div>
            <button
              type="button"
              className="admin-profiles-swap"
              onClick={handleSwapDimensions}
              disabled={submitting}
              title="Swap width and height (for vertical video)"
              aria-label="Swap width and height"
            >
              ⇄
            </button>
            <div>
              <label htmlFor="admin-profile-height">Height (px)</label>
              <input
                id="admin-profile-height"
                type="number"
                min="1"
                step="1"
                value={outputHeight}
                onChange={(event) => setOutputHeight(event.target.value)}
                required
                disabled={submitting}
              />
            </div>
          </div>

          <SelectOrCustom
            id="admin-profile-container"
            label="Output Container"
            options={CONTAINER_OPTIONS}
            value={outputContainer}
            onChange={setOutputContainer}
            disabled={submitting}
          />

          <label className="admin-profiles-checkbox">
            <input
              type="checkbox"
              checked={hardwareAccelerated}
              disabled={submitting || !hwStatus.enabled}
              onChange={(event) => setHardwareAccelerated(event.target.checked)}
            />
            Hardware-accelerated
          </label>
          {!hwStatus.enabled && (
            <p className="admin-profiles-hint">
              Hardware transcoding isn't currently enabled on this server.
            </p>
          )}

          <SelectOrCustom
            id="admin-profile-video-codec"
            label="Video Codec"
            options={hardwareAccelerated ? hwStatus.encoders : VIDEO_CODEC_OPTIONS}
            value={videoCodec}
            onChange={setVideoCodec}
            disabled={submitting}
          />

          <SelectOrCustom
            id="admin-profile-audio-codec"
            label="Audio Codec"
            options={AUDIO_CODEC_OPTIONS}
            value={audioCodec}
            onChange={setAudioCodec}
            disabled={submitting}
          />

          <button type="submit" className="settings-submit" disabled={submitting}>
            {submitting ? 'Saving...' : isEditMode ? 'Save Changes' : 'Create Profile'}
          </button>

          {isEditMode && (
            <button
              type="button"
              className="admin-profiles-delete"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? 'Deleting...' : 'Delete Profile'}
            </button>
          )}
        </form>
      </div>
    </section>
  )
}

export default AdminTranscodeProfiles
