import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import apiClient from '../api/client.js'
import * as watchPartyApi from '../api/watch-party.js'
import { WatchPartyContext } from './watch-party-context.js'
import { useAuth } from './useAuth.js'
import { useToast } from './useToast.js'
import { readActiveWatchPartySessionId, writeActiveWatchPartySessionId } from '../lib/watch-party-session.js'
import { readHideJoinInfo, writeHideJoinInfo } from '../lib/watch-party-hide-join-info.js'

const MAX_ACTIVITY_ENTRIES = 50

const EMPTY_PLAYBACK = { status: 'paused', positionSeconds: 0, updatedAt: null, serverTime: null }

// Clock handshake tuning. A burst on connect gets an offset estimate in place
// before the first player:tick arrives; the slow refresh afterwards tracks drift
// between the two machines' clocks over a long session.
const CLOCK_BURST_SAMPLES = 5
const CLOCK_BURST_INTERVAL_MS = 250
const CLOCK_REFRESH_INTERVAL_MS = 30000
// Only the lowest-RTT samples are trusted: round-trip delay is asymmetric under
// queueing, and a slow sample's error lands entirely in the offset.
const CLOCK_SAMPLE_WINDOW = 8

// How long to wait for a session snapshot before giving up on the join. Without
// this, a socket that never connects (or a stale session id out of
// localStorage) leaves the Watch Party page sitting on "Joining Watch Party…" forever.
const JOIN_TIMEOUT_MS = 15000

/**
 * Owns the live Watch Party session state and its socket.io-client
 * connection to the `/cast` namespace (unchanged on the wire - this is the
 * backend's real-time transport, not user-facing naming). The socket only
 * exists while `joinTarget` is set - set by
 * `createFromPlaylist`/`createFromVideo`/`createEmpty`/`joinByCode` (REST
 * calls that also create the underlying membership, and already know the
 * session's numeric id) or by `enterSession` (for a page landing directly on
 * `/cast/:code`, e.g. a reload or a shared link, where membership already
 * exists but only the join code is known). Every mutating action is a thin wrapper either
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
  // Shape: `{ sessionId } | { code } | null` - matches the `session:join`
  // socket payload directly (see `resolveJoinTarget` server-side), since a
  // page landing on the shareable `/cast/:code` URL only has the code, while
  // a fresh create/join already knows the numeric id.
  const [joinTarget, setJoinTarget] = useState(() => {
    const sessionId = readActiveWatchPartySessionId()
    return sessionId != null ? { sessionId } : null
  })
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
  // Set when the caller deliberately left the session (as opposed to it ending
  // or them being kicked). Mirrors `ended`: the session state is torn down
  // either way, so without a distinct signal WatchPartyPage can't tell "just
  // left" from "still joining" and strands the user on the joining message.
  // Declared above the render-body block below, which calls setLeft - a `const`
  // read before its declaration is a temporal-dead-zone ReferenceError.
  const [left, setLeft] = useState(false)
  // Adjusted during render (not the connect effect below) so starting a
  // fresh attempt clears any previous error/ended flag without a synchronous
  // setState-in-effect - same pattern as SearchAutocomplete's `clearedFor`.
  // Deliberately only fires when joinTarget becomes a new *non-null*
  // value (a new attempt) - it must NOT fire when joinTarget goes back
  // to null, since that's exactly what happens *when* a session goes away
  // (handleConnect's ack failure, handleKicked and handleEnded all null it
  // out in the same batch), which would otherwise erase the signal before
  // WatchPartyPage/WatchPartyDisplayPage's effect ever saw it. Comparing by
  // reference is fine: joinTarget is only ever replaced wholesale (never
  // mutated), and enterSession/create/join dedupe against an unchanged
  // target so this doesn't fire on every unrelated re-render.
  const [clearedFor, setClearedFor] = useState(null)
  if (joinTarget != null && joinTarget !== clearedFor) {
    setClearedFor(joinTarget)
    setJoinError(null)
    setEnded(false)
    setLeft(false)
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

  // Whether the join code/QR should stay concealed (behind a click-to-reveal
  // toggle) everywhere they're shown - the Watch Party page's sidebar and the
  // TopBar popover both read this from here so a single "Hide Join Info"
  // switch controls both. Persisted per session code (see
  // watch-party-hide-join-info.js) rather than at initial state, since the
  // code isn't known until the session snapshot arrives - adjusted during
  // render, same pattern as `clearedFor` above.
  const [hideJoinInfo, setHideJoinInfoState] = useState(false)
  const [hideJoinInfoLoadedFor, setHideJoinInfoLoadedFor] = useState(null)
  if (session?.code && session.code !== hideJoinInfoLoadedFor) {
    setHideJoinInfoLoadedFor(session.code)
    setHideJoinInfoState(readHideJoinInfo(session.code))
  }

  /**
   * Sets and persists whether the join code/QR should stay concealed.
   * @param {boolean} hidden
   * @returns {void}
   */
  function setHideJoinInfo(hidden) {
    setHideJoinInfoState(hidden)
    writeHideJoinInfo(session?.code, hidden)
  }

  const socketRef = useRef(null)
  // Estimated offset from the server's clock, in ms: serverNow ≈ Date.now() +
  // offsetMs. A ref, not state - it's read by the playback sync loop on every
  // evaluation and must never cause a re-render. `samples` keeps the most recent
  // round trips so the lowest-RTT one can be picked (see CLOCK_SAMPLE_WINDOW).
  const clockRef = useRef({ offsetMs: 0, rttMs: null, samples: [] })
  // Whether a snapshot has landed for the current session, read by the join
  // timeout below. A ref rather than reading `session`, so the timeout doesn't
  // need to be torn down and rescheduled on every state change.
  const snapshotArrivedRef = useRef(false)

  function applySnapshot(snapshot) {
    snapshotArrivedRef.current = true
    setSession(snapshot.session)
    setQueue(snapshot.queue ?? [])
    setHistory(snapshot.history ?? [])
    setNowPlaying(snapshot.nowPlaying ?? null)
    setPlayback(snapshot.playback ?? EMPTY_PLAYBACK)
    setMembers(snapshot.members ?? [])
  }

  function resetState() {
    snapshotArrivedRef.current = false
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

  // Mirror the active session's numeric id into localStorage so a reload can
  // pick it back up, regardless of whether this browser joined via a numeric
  // id (create/join) or a join code (a page landing on `/cast/:code`) - once
  // a snapshot lands, `session.id` is always known. Before that snapshot
  // arrives, fall back to `joinTarget.sessionId` when the join itself already
  // knew the id, so a reload mid-connect still has something to retry.
  // Writing an external store from an effect is exactly what effects are for,
  // so this stays out of the setters themselves.
  useEffect(() => {
    if (session) {
      writeActiveWatchPartySessionId(session.id)
    } else if (joinTarget?.sessionId != null) {
      writeActiveWatchPartySessionId(joinTarget.sessionId)
    } else if (joinTarget == null) {
      writeActiveWatchPartySessionId(null)
    }
  }, [joinTarget, session])

  // Opens (and tears down) the socket connection whenever joinTarget
  // changes - this is the "lazy connect" seam: no socket exists at all until
  // a session is created/joined/entered.
  useEffect(() => {
    if (joinTarget == null || !user) {
      return undefined
    }

    const socket = io(`${apiClient.defaults.baseURL}/cast`, { withCredentials: true })
    socketRef.current = socket
    clockRef.current = { offsetMs: 0, rttMs: null, samples: [] }

    // The burst is re-armed on every connect (including reconnects); the refresh
    // interval is created once, below, so reconnecting can't stack up intervals.
    let burstTimers = []

    /**
     * Takes one `time:sync` round trip and folds it into the offset estimate.
     * `offset = serverTime + rtt / 2 - now` assumes a symmetric round trip,
     * which is only roughly true - hence keeping a window of samples and
     * trusting the one with the lowest RTT, the least distorted by queueing.
     *
     * @returns {void}
     */
    function sampleClock() {
      if (!socket.connected) {
        return
      }
      const clientSent = Date.now()
      socket.emit('time:sync', { clientSent }, (ack) => {
        const serverTime = Number(ack?.serverTime)
        if (!Number.isFinite(serverTime)) {
          return
        }
        const now = Date.now()
        const rttMs = now - clientSent
        const samples = [
          ...clockRef.current.samples,
          { offsetMs: serverTime + rttMs / 2 - now, rttMs },
        ].slice(-CLOCK_SAMPLE_WINDOW)
        const best = samples.reduce((a, b) => (b.rttMs < a.rttMs ? b : a))
        clockRef.current = { offsetMs: best.offsetMs, rttMs: best.rttMs, samples }
      })
    }

    function handleConnect() {
      setConnected(true)
      // A burst on (re)connect, so an offset is in place before the first
      // player:tick and a new connection's latency is measured fresh.
      for (const timer of burstTimers) {
        clearTimeout(timer)
      }
      burstTimers = []
      for (let i = 0; i < CLOCK_BURST_SAMPLES; i += 1) {
        burstTimers.push(setTimeout(sampleClock, i * CLOCK_BURST_INTERVAL_MS))
      }

      socket.emit('session:join', joinTarget, (ack) => {
        if (!ack?.ok) {
          const message = ack?.error?.message || 'Failed to join the Watch Party.'
          toastError(message)
          setJoinError(message)
          setJoinTarget(null)
          resetState()
        }
      })
    }
    function handleDisconnect() {
      setConnected(false)
    }
    // socket.io keeps retrying on its own, so this doesn't give up - it just
    // makes the failure visible instead of leaving the page on "Joining…".
    function handleConnectError(err) {
      console.error('CAST socket connection failed:', err?.message || err)
    }
    function handleStateSync(snapshot) {
      applySnapshot(snapshot)
    }
    function handleTick(tick) {
      setPlayback({
        status: tick.status,
        positionSeconds: tick.positionSeconds,
        updatedAt: tick.updatedAt,
        serverTime: tick.serverTime,
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
      setJoinTarget(null)
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
      setJoinTarget(null)
      resetState()
    }

    socket.on('connect', handleConnect)
    socket.on('connect_error', handleConnectError)
    socket.on('disconnect', handleDisconnect)
    socket.on('state:sync', handleStateSync)
    socket.on('player:tick', handleTick)
    socket.on('activity', handleActivity)
    socket.on('presence', handlePresence)
    socket.on('react', handleReact)
    socket.on('session:kicked', handleKicked)
    socket.on('session:ended', handleEnded)

    // Nothing above ever fires if the socket can't connect at all, or if the
    // stored session id is stale, so bound the wait: joinError is the signal
    // WatchPartyPage/WatchPartyDisplayPage already redirect on.
    const joinTimeout = setTimeout(() => {
      if (snapshotArrivedRef.current) {
        return
      }
      const message = 'Could not join the Watch Party. It may have ended.'
      toastError(message)
      setJoinError(message)
      setJoinTarget(null)
      resetState()
    }, JOIN_TIMEOUT_MS)

    // Created once for the life of this socket - the two clocks drift apart over
    // a long session, so the estimate needs refreshing even without a reconnect.
    const clockRefreshTimer = setInterval(sampleClock, CLOCK_REFRESH_INTERVAL_MS)

    return () => {
      clearTimeout(joinTimeout)
      clearInterval(clockRefreshTimer)
      for (const timer of burstTimers) {
        clearTimeout(timer)
      }
      socket.disconnect()
      socketRef.current = null
      setConnected(false)
    }
    // toastError/toastInfo deliberately omitted: they're context functions
    // that would tear down and reopen the socket on every ToastProvider
    // re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinTarget, user])

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
      setJoinTarget({ sessionId: result.session.id })
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
      setJoinTarget({ sessionId: result.session.id })
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
      setJoinTarget({ sessionId: result.session.id })
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
      setJoinTarget({ sessionId: result.session.id })
      return result
    } finally {
      setLoading(false)
    }
  }

  /**
   * Makes an already-joined session (membership already exists) the active
   * one, for a page landing directly on `/cast/:code` - a reload, or a link
   * shared after the fact - without re-running create/join. Takes the join
   * code (that's all the URL carries) rather than the numeric id; the socket
   * resolves it server-side the same way a REST join-by-code would.
   * @param {string} code
   * @returns {void}
   */
  function enterSession(code) {
    // Dedupe against the current target so effects that re-run for unrelated
    // reasons (e.g. `user` refreshing) don't tear down and reopen the socket
    // when the code hasn't actually changed.
    setJoinTarget((prev) => (prev?.code === code ? prev : { code }))
  }

  /**
   * Disconnects the socket and clears local session state, without any
   * server-side effect - membership itself isn't revoked, so the session can
   * be re-entered later (e.g. via `enterSession`) until the owner ends it or
   * kicks the caller.
   * @returns {void}
   */
  function leaveActiveSession() {
    setLeft(true)
    setJoinTarget(null)
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
    setLeft(true)
    setJoinTarget(null)
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
   * Sets whether the active session auto-advances to the next queued item
   * once the current one finishes (owner or admin). The server broadcasts
   * `state:sync` afterwards, so local state updates through the socket.
   * @param {boolean} enabled
   * @returns {Promise<void>}
   */
  async function setAutoAdvance(enabled) {
    if (!session) return
    await watchPartyApi.setWatchPartyAutoAdvance(session.id, enabled)
  }

  /**
   * The server's current clock, in epoch ms, per the latest `time:sync`
   * estimate. Every CAST playback calculation goes through this rather than
   * `Date.now()` - a client whose wall clock is off by a few seconds would
   * otherwise fold that error straight into its seek target.
   *
   * @returns {number} Estimated server time as epoch ms.
   */
  function getServerNow() {
    return Date.now() + clockRef.current.offsetMs
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

  /**
   * Appends a whole playlist to the queue. The ack carries `addedCount`, which
   * can be lower than the playlist's length - videos the caller can't see are
   * skipped rather than failing the add.
   * @param {number} playlistId
   * @returns {Promise<object>}
   */
  function addPlaylistToQueue(playlistId) {
    return emitWithAck('queue:add-playlist', { playlistId })
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

  /**
   * Reports that the local player's current video finished naturally.
   * `queueItemId` (`nowPlaying.id`) lets the server ignore duplicate reports
   * from other members whose players end at the same moment.
   *
   * @param {number} queueItemId CAST_QUEUE_ITEMS id of the item that finished.
   * @returns {Promise<object>}
   */
  function reportEnded(queueItemId) {
    return emitWithAck('player:ended', { queueItemId })
  }

  /**
   * Reports that the local player's current video hit a playback error.
   *
   * @param {number} queueItemId CAST_QUEUE_ITEMS id of the item that failed.
   * @returns {Promise<object>}
   */
  function reportError(queueItemId) {
    return emitWithAck('player:error', { queueItemId })
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
   * clearing: nulling joinTarget tears the socket down in the connect
   * effect's cleanup, which races the inbound event.
   * @returns {Promise<void>}
   */
  async function endActiveSession() {
    if (!session) return
    await watchPartyApi.endWatchParty(session.id)
    setEnded(true)
    setJoinTarget(null)
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
        left,
        session,
        hideJoinInfo,
        setHideJoinInfo,
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
        getServerNow,
        createFromPlaylist,
        createFromVideo,
        createEmpty,
        joinByCode,
        enterSession,
        leaveActiveSession,
        leaveSession,
        renameSession,
        setAutoAdvance,
        addToQueue,
        addPlaylistToQueue,
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
