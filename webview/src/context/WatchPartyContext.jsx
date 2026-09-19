import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import apiClient from '../api/client.js'
import * as watchPartyApi from '../api/watch-party.js'
import { WatchPartyContext } from './watch-party-context.js'
import { useAuth } from './useAuth.js'
import { useToast } from './useToast.js'
import { readActiveWatchPartySessionId, writeActiveWatchPartySessionId } from '../lib/watch-party-session.js'

const MAX_ACTIVITY_ENTRIES = 50

const EMPTY_PLAYBACK = { status: 'paused', positionSeconds: 0, updatedAt: null }

/**
 * Owns the live Watch Party session state and its socket.io-client
 * connection to the `/cast` namespace (unchanged on the wire - this is the
 * backend's real-time transport, not user-facing naming). The socket only
 * exists while `activeSessionId` is set - set by
 * `createFromPlaylist`/`createFromVideo`/`createEmpty`/`joinByCode` (REST
 * calls that also create the underlying membership) or by `enterSession`
 * (for a page landing directly on `/cast/:id`, e.g. a reload, where
 * membership already exists). Every mutating action is a thin wrapper either
 * over `webview/src/api/watch-party.js` (REST: create/join/kick/end) or a
 * socket emit-with-ack (queue/playback/reactions) - see
 * `webapi/lib/cast/realtime.js` for the server-side event catalog this
 * mirrors.
 */
export function WatchPartyProvider({ children }) {
  const { user } = useAuth()
  const { error: toastError, info: toastInfo } = useToast()

  // Seeded from localStorage so a reload rejoins the session the user was in,
  // rather than silently dropping them out of the party. The socket's join ack
  // rejects a stale or ended id, which clears it through the usual path.
  const [activeSessionId, setActiveSessionId] = useState(readActiveWatchPartySessionId)
  const [connected, setConnected] = useState(false)
  // Set whenever a join attempt fails or a live session goes away out from
  // under the caller (kicked, or otherwise no longer a member) - the one
  // signal WatchPartyPage/WatchPartyDisplayPage watch to redirect away,
  // covering both "never got in" and "was in, then kicked" without needing
  // to distinguish them separately.
  const [joinError, setJoinError] = useState(null)
  // Set when the session the caller was in ended normally (owner or admin),
  // as opposed to joinError's "you can't be here" cases. Kept separate so the
  // pages can show "this session has ended" rather than an error, while the
  // session state itself is cleared out from under them - see handleEnded.
  const [ended, setEnded] = useState(false)
  // Adjusted during render (not the connect effect below) so starting a
  // fresh attempt clears any previous error/ended flag without a synchronous
  // setState-in-effect - same pattern as SearchAutocomplete's `clearedFor`.
  // Deliberately only fires when activeSessionId becomes a new *non-null*
  // value (a new attempt) - it must NOT fire when activeSessionId goes back
  // to null, since that's exactly what happens *when* a session goes away
  // (handleConnect's ack failure, handleKicked and handleEnded all null it
  // out in the same batch), which would otherwise erase the signal before
  // WatchPartyPage/WatchPartyDisplayPage's effect ever saw it.
  const [clearedFor, setClearedFor] = useState(null)
  if (activeSessionId != null && activeSessionId !== clearedFor) {
    setClearedFor(activeSessionId)
    setJoinError(null)
    setEnded(false)
  }
  const [session, setSession] = useState(null)
  const [queue, setQueue] = useState([])
  const [history, setHistory] = useState([])
  const [nowPlaying, setNowPlaying] = useState(null)
  const [playback, setPlayback] = useState(EMPTY_PLAYBACK)
  const [members, setMembers] = useState([])
  const [presence, setPresence] = useState([])
  const [activity, setActivity] = useState([])
  const [loading, setLoading] = useState(false)

  const socketRef = useRef(null)

  function applySnapshot(snapshot) {
    setSession(snapshot.session)
    setQueue(snapshot.queue ?? [])
    setHistory(snapshot.history ?? [])
    setNowPlaying(snapshot.nowPlaying ?? null)
    setPlayback(snapshot.playback ?? EMPTY_PLAYBACK)
    setMembers(snapshot.members ?? [])
  }

  function resetState() {
    setSession(null)
    setQueue([])
    setHistory([])
    setNowPlaying(null)
    setPlayback(EMPTY_PLAYBACK)
    setMembers([])
    setPresence([])
    setActivity([])
  }

  function pushActivity(entry) {
    setActivity((prev) => [...prev.slice(-(MAX_ACTIVITY_ENTRIES - 1)), entry])
  }

  // Mirror the active session into localStorage so a reload can pick it back
  // up. Writing an external store from an effect is exactly what effects are
  // for, so this stays out of the setters themselves.
  useEffect(() => {
    writeActiveWatchPartySessionId(activeSessionId)
  }, [activeSessionId])

  // Opens (and tears down) the socket connection whenever activeSessionId
  // changes - this is the "lazy connect" seam: no socket exists at all until
  // a session is created/joined/entered.
  useEffect(() => {
    if (activeSessionId == null || !user) {
      return undefined
    }

    const socket = io(`${apiClient.defaults.baseURL}/cast`, { withCredentials: true })
    socketRef.current = socket

    function handleConnect() {
      setConnected(true)
      socket.emit('session:join', { sessionId: activeSessionId }, (ack) => {
        if (!ack?.ok) {
          const message = ack?.error?.message || 'Failed to join the Watch Party.'
          toastError(message)
          setJoinError(message)
          setActiveSessionId(null)
          resetState()
        }
      })
    }
    function handleDisconnect() {
      setConnected(false)
    }
    function handleStateSync(snapshot) {
      applySnapshot(snapshot)
    }
    function handleTick(tick) {
      setPlayback({
        status: tick.status,
        positionSeconds: tick.positionSeconds,
        updatedAt: tick.updatedAt,
      })
    }
    function handleActivity(entry) {
      pushActivity(entry)
    }
    function handlePresence(payload) {
      setPresence(payload?.members ?? [])
    }
    function handleReact(payload) {
      pushActivity({
        type: 'reaction',
        actorName: payload.name,
        text: payload.emoji,
        at: new Date().toISOString(),
        emoji: payload.emoji,
      })
    }
    function handleKicked() {
      const message = 'You were removed from this Watch Party.'
      toastError(message)
      setJoinError(message)
      setActiveSessionId(null)
      resetState()
    }
    // Mirrors handleKicked: the session is gone, so every trace of it has to
    // go too. Patching status in place used to leave `session` truthy, which
    // kept StartWatchPartyPopover showing the QR code and join link for a dead
    // session app-wide (it lives in the TopBar, so it outlives the watch
    // party page).
    function handleEnded() {
      toastInfo('This Watch Party has ended.')
      setEnded(true)
      setActiveSessionId(null)
      resetState()
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('state:sync', handleStateSync)
    socket.on('player:tick', handleTick)
    socket.on('activity', handleActivity)
    socket.on('presence', handlePresence)
    socket.on('react', handleReact)
    socket.on('session:kicked', handleKicked)
    socket.on('session:ended', handleEnded)

    return () => {
      socket.disconnect()
      socketRef.current = null
      setConnected(false)
    }
    // toastError/toastInfo deliberately omitted: they're context functions
    // that would tear down and reopen the socket on every ToastProvider
    // re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, user])

  /**
   * Creates a session seeded from a playlist and makes it the active one.
   * @param {number} playlistId
   * @returns {Promise<object>} The created session snapshot.
   */
  async function createFromPlaylist(playlistId) {
    setLoading(true)
    try {
      const result = await watchPartyApi.createWatchParty({ sourceType: 'playlist', playlistId })
      applySnapshot(result)
      setActiveSessionId(result.session.id)
      return result
    } finally {
      setLoading(false)
    }
  }

  /**
   * Creates a session seeded from a single video and makes it the active one.
   * @param {string} videoId
   * @returns {Promise<object>} The created session snapshot.
   */
  async function createFromVideo(videoId) {
    setLoading(true)
    try {
      const result = await watchPartyApi.createWatchParty({ sourceType: 'video', videoId })
      applySnapshot(result)
      setActiveSessionId(result.session.id)
      return result
    } finally {
      setLoading(false)
    }
  }

  /**
   * Creates an empty session and makes it the active one.
   * @returns {Promise<object>} The created session snapshot.
   */
  async function createEmpty() {
    setLoading(true)
    try {
      const result = await watchPartyApi.createWatchParty({ sourceType: 'empty' })
      applySnapshot(result)
      setActiveSessionId(result.session.id)
      return result
    } finally {
      setLoading(false)
    }
  }

  /**
   * Joins a session by its code and makes it the active one.
   * @param {string} code
   * @returns {Promise<object>} The joined session snapshot.
   */
  async function joinByCode(code) {
    setLoading(true)
    try {
      const result = await watchPartyApi.joinWatchParty(code)
      applySnapshot(result)
      setActiveSessionId(result.session.id)
      return result
    } finally {
      setLoading(false)
    }
  }

  /**
   * Makes an already-joined session (membership already exists) the active
   * one, for a page landing directly on `/cast/:id` - a reload, or a link
   * shared after the fact - without re-running create/join.
   * @param {string|number} sessionId
   * @returns {void}
   */
  function enterSession(sessionId) {
    setActiveSessionId(Number(sessionId))
  }

  /**
   * Disconnects the socket and clears local session state, without any
   * server-side effect - membership itself isn't revoked, so the session can
   * be re-entered later (e.g. via `enterSession`) until the owner ends it or
   * kicks the caller.
   * @returns {void}
   */
  function leaveActiveSession() {
    setActiveSessionId(null)
    resetState()
  }

  /**
   * Leaves the session for real: drops membership server-side, then tears the
   * local state down. Distinct from `leaveActiveSession`, which only stops
   * tracking a session locally - now that a session survives navigation, this
   * is the only deliberate way out short of the owner ending it.
   * @returns {Promise<void>}
   */
  async function leaveSession() {
    if (!session) return
    await watchPartyApi.leaveWatchParty(session.id)
    setActiveSessionId(null)
    resetState()
  }

  /**
   * Renames the active session (owner or admin). The server broadcasts
   * `state:sync` afterwards, so local state updates through the socket rather
   * than from this response.
   * @param {string} title
   * @returns {Promise<void>}
   */
  async function renameSession(title) {
    if (!session) return
    await watchPartyApi.renameWatchParty(session.id, title)
  }

  /**
   * Emits a mutating socket event and resolves/rejects based on its ack.
   * @param {string} event
   * @param {object} payload
   * @returns {Promise<object>} The ack payload on success.
   */
  function emitWithAck(event, payload) {
    return new Promise((resolve, reject) => {
      const socket = socketRef.current
      if (!socket || !socket.connected) {
        reject(new Error('Not connected to the Watch Party.'))
        return
      }
      socket.emit(event, payload, (ack) => {
        if (ack?.ok) {
          resolve(ack)
        } else {
          reject(new Error(ack?.error?.message || 'Action failed.'))
        }
      })
    })
  }

  /** @param {string} videoId @returns {Promise<object>} */
  function addToQueue(videoId) {
    return emitWithAck('queue:add', { videoId })
  }

  /** @param {string|number} queueItemId @returns {Promise<object>} */
  function removeFromQueue(queueItemId) {
    return emitWithAck('queue:remove', { queueItemId })
  }

  /** @param {string|number} queueItemId @param {number} toIndex @returns {Promise<object>} */
  function moveInQueue(queueItemId, toIndex) {
    return emitWithAck('queue:move', { queueItemId, toIndex })
  }

  /** @returns {Promise<object>} */
  function play() {
    return emitWithAck('player:play', {})
  }

  /** @returns {Promise<object>} */
  function pause() {
    return emitWithAck('player:pause', {})
  }

  /** @param {number} seconds @returns {Promise<object>} */
  function seek(seconds) {
    return emitWithAck('player:seek', { seconds })
  }

  /** @returns {Promise<object>} */
  function skip() {
    return emitWithAck('player:skip', {})
  }

  /** @returns {Promise<object>} */
  function previous() {
    return emitWithAck('player:previous', {})
  }

  /** Reports that the local player's current video finished naturally. @returns {Promise<object>} */
  function reportEnded() {
    return emitWithAck('player:ended', {})
  }

  /** Reports that the local player's current video hit a playback error. @returns {Promise<object>} */
  function reportError() {
    return emitWithAck('player:error', {})
  }

  /**
   * Fire-and-forget emoji reaction; no ack, matching the server's
   * fire-and-forget `react` handler.
   * @param {string} emoji
   * @returns {void}
   */
  function sendReaction(emoji) {
    const socket = socketRef.current
    if (!socket || !socket.connected) return
    socket.emit('react', { emoji })
  }

  /**
   * Kicks a member (owner only) via REST.
   * @param {number} userId
   * @returns {Promise<void>}
   */
  async function kickMember(userId) {
    if (!session) return
    await watchPartyApi.kickWatchPartyMember(session.id, userId)
  }

  /**
   * Ends the active session (owner or admin) via REST, then clears local
   * state. It can't wait for its own `session:ended` broadcast to do the
   * clearing: nulling activeSessionId tears the socket down in the connect
   * effect's cleanup, which races the inbound event.
   * @returns {Promise<void>}
   */
  async function endActiveSession() {
    if (!session) return
    await watchPartyApi.endWatchParty(session.id)
    setEnded(true)
    setActiveSessionId(null)
    resetState()
  }

  const isOwner = Boolean(user && session && Number(session.ownerUserId) === Number(user.id))
  // Mirrors the server's owner-or-admin check on rename/end, so the UI only
  // offers what the API will actually accept.
  const canManageSession = Boolean(session && (isOwner || user?.role === 'admin'))

  return (
    <WatchPartyContext.Provider
      value={{
        connected,
        joinError,
        ended,
        session,
        queue,
        history,
        nowPlaying,
        playback,
        members,
        presence,
        activity,
        loading,
        isOwner,
        canManageSession,
        createFromPlaylist,
        createFromVideo,
        createEmpty,
        joinByCode,
        enterSession,
        leaveActiveSession,
        leaveSession,
        renameSession,
        addToQueue,
        removeFromQueue,
        moveInQueue,
        play,
        pause,
        seek,
        skip,
        previous,
        reportEnded,
        reportError,
        sendReaction,
        kickMember,
        endActiveSession,
      }}
    >
      {children}
    </WatchPartyContext.Provider>
  )
}
