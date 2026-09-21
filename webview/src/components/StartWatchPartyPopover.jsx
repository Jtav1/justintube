import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Copy, Pencil, Play, Users, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { listMyPlaylists } from '../api/playlists.js'
import { useWatchParty } from '../context/useWatchParty.js'
import { useToast } from '../context/useToast.js'
import { useDismissablePopover } from '../hooks/useDismissablePopover.js'
import RevealableSecret from './RevealableSecret.jsx'
import './StartWatchPartyPopover.css'

// Fixed pixel size the QR is rendered at internally; the enlarged modal scales
// it back down (or up) to fit the viewport via CSS, since QRCodeSVG draws a
// real viewBox rather than a raster image - see the `qr-scan-modal-qr` rule.
const QR_MODAL_RENDER_SIZE = 1024

const DROPDOWN_WIDTH = 300
const VIEWPORT_MARGIN = 12

/**
 * Computes a fixed-position anchor for the dropdown from the toggle
 * button's rect, mirroring NotificationBell's identical helper.
 * @param {DOMRect} rect
 * @returns {{top: number, right: number, width: number}}
 */
function computeDropdownPosition(rect) {
  const width = Math.min(DROPDOWN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)
  const idealRight = window.innerWidth - rect.right
  const maxRight = window.innerWidth - width - VIEWPORT_MARGIN
  return { top: rect.bottom + 6, right: Math.min(idealRight, maxRight), width }
}

/**
 * TopBar's Watch Party entry point: a button that opens a dropdown to start a
 * new session (from a playlist, the current video, or empty) or join one by
 * code, and - once a session is active - shows its join code and QR code.
 */
function StartWatchPartyPopover() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { error: toastError } = useToast()
  const {
    session,
    canManageSession,
    hideJoinInfo,
    createFromPlaylist,
    createFromVideo,
    createEmpty,
    joinByCode,
    leaveSession,
    renameSession,
    endActiveSession,
  } = useWatchParty()

  const [open, setOpen] = useState(false)
  const [dropdownPosition, setDropdownPosition] = useState(null)
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [playlists, setPlaylists] = useState(null)
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [qrModalOpen, setQrModalOpen] = useState(false)

  const menuRef = useRef(null)
  const toggleRef = useRef(null)
  const dropdownRef = useRef(null)
  const qrTriggerRef = useRef(null)

  const currentVideoId = location.pathname === '/video' ? searchParams.get('v') : null

  useEffect(() => {
    if (!open) {
      return undefined
    }
    function handleClickOutside(event) {
      const clickedToggle = menuRef.current?.contains(event.target)
      const clickedDropdown = dropdownRef.current?.contains(event.target)
      if (!clickedToggle && !clickedDropdown) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  useDismissablePopover(open, () => setOpen(false), toggleRef)

  // Capture phase + stopPropagation so Escape closes only the enlarged QR
  // modal, not the whole popover underneath it - both listen on `document`,
  // and the popover's own Escape handler above (bubble phase) would otherwise
  // fire too and close both at once.
  useEffect(() => {
    if (!qrModalOpen) {
      return undefined
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setQrModalOpen(false)
        qrTriggerRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [qrModalOpen])

  useEffect(() => {
    if (!open) {
      return undefined
    }
    function handleResize() {
      if (toggleRef.current) {
        setDropdownPosition(computeDropdownPosition(toggleRef.current.getBoundingClientRect()))
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [open])

  function handleToggle() {
    if (open) {
      setOpen(false)
      setRenaming(false)
      return
    }
    if (toggleRef.current) {
      setDropdownPosition(computeDropdownPosition(toggleRef.current.getBoundingClientRect()))
    }
    if (playlists === null && !session) {
      setPlaylists([])
      listMyPlaylists({ limit: 99 })
        .then((data) => setPlaylists(data.items ?? []))
        .catch(() => setPlaylists([]))
    }
    setOpen(true)
  }

  async function handleJoin(event) {
    event.preventDefault()
    if (!joinCode.trim() || busy) return
    setBusy(true)
    try {
      const result = await joinByCode(joinCode.trim())
      setOpen(false)
      navigate(`/cast/${result.session.code}`)
    } catch (err) {
      toastError(err.message || 'Failed to join the Watch Party.')
    } finally {
      setBusy(false)
    }
  }

  async function handleStart(action) {
    if (busy) return
    setBusy(true)
    try {
      const result = await action()
      setOpen(false)
      navigate(`/cast/${result.session.code}`)
    } catch (err) {
      toastError(err.message || 'Failed to start the Watch Party.')
    } finally {
      setBusy(false)
    }
  }

  async function handleRename(event) {
    event.preventDefault()
    const title = titleDraft.trim()
    if (!title || busy) return
    setBusy(true)
    try {
      // The new title arrives back through the socket's state:sync broadcast,
      // so there's nothing to set locally here.
      await renameSession(title)
      setRenaming(false)
    } catch (err) {
      toastError(err.message || 'Failed to rename the session.')
    } finally {
      setBusy(false)
    }
  }

  async function handleLeave() {
    if (busy) return
    setBusy(true)
    try {
      await leaveSession()
      setOpen(false)
    } catch (err) {
      toastError(err.message || 'Failed to leave the session.')
    } finally {
      setBusy(false)
    }
  }

  async function handleEnd() {
    if (busy) return
    if (!window.confirm('End this Watch Party for everyone?')) {
      return
    }
    setBusy(true)
    try {
      await endActiveSession()
      setOpen(false)
    } catch (err) {
      toastError(err.message || 'Failed to end the session.')
    } finally {
      setBusy(false)
    }
  }

  async function handleCopyLink() {
    if (!session) return
    const url = `${window.location.origin}/cast/join?code=${session.code}`
    await navigator.clipboard.writeText(url)
  }

  const joinUrl = session ? `${window.location.origin}/cast/join?code=${session.code}` : ''

  return (
    <div className="watch-party-popover" ref={menuRef}>
      <button
        type="button"
        className="topbar-watch-party-btn"
        onClick={handleToggle}
        aria-label="Start or join a Watch Party"
        title="Watch Party"
        aria-haspopup="true"
        aria-expanded={open}
        ref={toggleRef}
      >
        <Users size={20} />
      </button>
      {open && dropdownPosition && createPortal(
        <div
          className="watch-party-popover-menu"
          role="menu"
          ref={dropdownRef}
          style={{
            position: 'fixed',
            top: dropdownPosition.top,
            right: dropdownPosition.right,
            width: dropdownPosition.width,
          }}
        >
          {session ? (
            <div className="watch-party-popover-active">
              {renaming ? (
                <form className="watch-party-popover-rename" onSubmit={handleRename}>
                  <input
                    type="text"
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    maxLength={255}
                    aria-label="Session name"
                    autoFocus
                  />
                  <div className="watch-party-popover-rename-actions">
                    <button type="submit" disabled={busy || !titleDraft.trim()}>
                      Save
                    </button>
                    <button type="button" onClick={() => setRenaming(false)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className="watch-party-popover-title-row">
                  <p className="watch-party-popover-heading">{session.title}</p>
                  {canManageSession && (
                    <button
                      type="button"
                      className="watch-party-popover-rename-btn"
                      aria-label="Rename session"
                      title="Rename session"
                      onClick={() => {
                        setTitleDraft(session.title ?? '')
                        setRenaming(true)
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                </div>
              )}
              {/* Concealed behind a click-to-reveal toggle when "Hide Join
                  Info" (set on the Watch Party page) is on - this popover
                  stays open on screen, screen shares included. Shown plainly
                  when it's off. */}
              {hideJoinInfo ? (
                <RevealableSecret as="div" label="QR code" variant="blur">
                  <span className="watch-party-popover-qr">
                    <QRCodeSVG value={joinUrl} size={160} marginSize={2} />
                  </span>
                </RevealableSecret>
              ) : (
                <button
                  type="button"
                  className="watch-party-popover-qr watch-party-popover-qr-button"
                  ref={qrTriggerRef}
                  onClick={() => setQrModalOpen(true)}
                  aria-label="Enlarge QR code for scanning"
                  title="Enlarge for scanning"
                >
                  <QRCodeSVG value={joinUrl} size={160} marginSize={2} />
                </button>
              )}
              <p className="watch-party-popover-code-label">Join code</p>
              {hideJoinInfo ? (
                <RevealableSecret as="p" label="join code" className="watch-party-popover-code">
                  {session.code}
                </RevealableSecret>
              ) : (
                <p className="watch-party-popover-code">{session.code}</p>
              )}
              <button type="button" className="watch-party-popover-copy" onClick={handleCopyLink}>
                <Copy size={14} /> Copy join link
              </button>
              <button
                type="button"
                className="watch-party-popover-open"
                onClick={() => {
                  setOpen(false)
                  navigate(`/cast/${session.code}`)
                }}
              >
                Open session
              </button>
              <button
                type="button"
                className="watch-party-popover-leave"
                disabled={busy}
                onClick={handleLeave}
              >
                Leave session
              </button>
              {canManageSession && (
                <button
                  type="button"
                  className="watch-party-popover-end"
                  disabled={busy}
                  onClick={handleEnd}
                >
                  End session
                </button>
              )}
            </div>
          ) : (
            <>
              <form className="watch-party-popover-join" onSubmit={handleJoin}>
                <p className="watch-party-popover-heading">Join by code</p>
                <div className="watch-party-popover-join-row">
                  <input
                    type="text"
                    value={joinCode}
                    onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                    placeholder="ABC123"
                    maxLength={8}
                    aria-label="Watch Party join code"
                  />
                  <button type="submit" disabled={busy || !joinCode.trim()}>Join</button>
                </div>
              </form>

              <div className="watch-party-popover-divider" />

              <p className="watch-party-popover-heading">Start a session</p>
              <div className="watch-party-popover-start-list">
                {currentVideoId && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleStart(() => createFromVideo(currentVideoId))}
                  >
                    From this video
                  </button>
                )}
                <button
                  type="button"
                  className="watch-party-popover-start"
                  disabled={busy}
                  onClick={() => handleStart(createEmpty)}
                >
                  Start Session <Play size={14} />
                </button>
              </div>

              {playlists && playlists.length > 0 && (
                <div className="watch-party-popover-playlist-row">
                  <select
                    value={selectedPlaylistId}
                    onChange={(event) => setSelectedPlaylistId(event.target.value)}
                    aria-label="Choose a playlist"
                  >
                    <option value="">Choose a playlist…</option>
                    {playlists.map((playlist) => (
                      <option key={playlist.id} value={playlist.id}>
                        {playlist.title}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy || !selectedPlaylistId}
                    onClick={() => handleStart(() => createFromPlaylist(Number(selectedPlaylistId)))}
                  >
                    Start
                  </button>
                </div>
              )}
            </>
          )}
        </div>,
        document.body,
      )}
      {qrModalOpen && session && createPortal(
        <div
          className="qr-scan-modal-overlay"
          onClick={() => setQrModalOpen(false)}
        >
          <div
            className="qr-scan-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Watch Party QR code"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="qr-scan-modal-close"
              onClick={() => setQrModalOpen(false)}
              aria-label="Close"
            >
              <X size={24} />
            </button>
            <div className="qr-scan-modal-qr">
              <QRCodeSVG
                value={joinUrl}
                size={QR_MODAL_RENDER_SIZE}
                marginSize={2}
                style={{ width: '100%', height: '100%' }}
              />
            </div>
            <p className="qr-scan-modal-code">{session.code}</p>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

export default StartWatchPartyPopover
