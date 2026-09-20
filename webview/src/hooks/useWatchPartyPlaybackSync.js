import { useCallback, useEffect, useRef } from 'react'

// How often drift is evaluated. Deliberately decoupled from the rate events
// arrive at: the server ticks once a second but also broadcasts a full
// state:sync on every queue edit, member join and rename, and correcting once
// per inbound event meant a burst of edits became a burst of seeks.
const EVALUATE_INTERVAL_MS = 500

// Drift below this is left alone entirely. Wide enough to cover ordinary
// decode/tick jitter, narrow enough that nobody can perceive the difference.
const DEAD_BAND_SECONDS = 0.25

// Between the dead band and this, drift is corrected by nudging playbackRate
// instead of seeking - inaudible at these magnitudes and, unlike a seek, it
// costs no range request and never rebuffers. Past it, only a seek will do.
const SOFT_BAND_SECONDS = 1.5

// Proportional gain and clamp for the rate nudge. 10% closes the full soft
// band in ~15s, and typical steady-state drift in far less.
const RATE_GAIN = 0.12
const MAX_RATE_ADJUST = 0.1

// Once a nudge is in effect it stays in effect until drift is well inside the
// dead band, rather than snapping back to 1.0 the instant it crosses 0.25.
// Without this gap the controller limit-cycles across the band edge: correct,
// snap to 1.0, immediately drift back out, correct again - a playbackRate write
// every second or two forever, each one a chance for the audio time-stretcher
// to click.
const RESYNC_EXIT_BAND_SECONDS = 0.1

// While a remote device is rendering (AirPlay receiver, Chromecast) the numbers
// above are the wrong ones to use. The receiver buffers a second or two behind
// the local element, so most of the measured drift is structural rather than
// real, and it cannot be corrected away - while every playbackRate or
// currentTime write forces the receiver to re-sync, which is exactly the
// stutter an Apple TV shows during a Watch Party (and never shows for an
// ordinary video, which has no sync loop writing to the element at all). So:
// no rate nudging whatsoever, and a seek only for a gap far too large to be
// buffer latency.
const REMOTE_SEEK_THRESHOLD_SECONDS = 5
const REMOTE_SEEK_COOLDOWN_MS = 6000

// A paused session has no clock running, so there is nothing to nudge towards -
// only worth a seek, and only once the gap is clearly not just jitter.
const PAUSED_SEEK_THRESHOLD_SECONDS = 0.5

// After a hard seek, stop correcting for this long: the element needs to
// actually buffer and settle at the new position, and measuring it mid-flight
// is what turns one correction into a seek storm.
const SEEK_COOLDOWN_MS = 2000

// After the local user plays, pauses or scrubs, their own intent wins for this
// long - enough for the emit to reach the server and the authoritative state to
// come back, so the correction loop does not undo them in the meantime.
const LOCAL_INTENT_GRACE_MS = 1200

// HAVE_CURRENT_DATA. Below this the element cannot act on a seek or a rate
// change in any meaningful way, so corrections are skipped rather than stacked.
const MIN_READY_STATE = 2

/**
 * Computes the server clock's current effective position from a playback
 * payload.
 *
 * `positionSeconds` is the position as of `playback.serverTime` (see webapi's
 * lib/cast/queue-service.js `playbackSnapshot`), so the elapsed time is measured
 * from *that* stamp - not from `updatedAt`, which is the older "when a control
 * action last moved the clock" timestamp and would count the same elapsed
 * seconds a second time.
 *
 * @param {{status: string, positionSeconds: number, serverTime: string|null, updatedAt: string|null}} playback Playback payload from the session.
 * @param {number} serverNowMs The server's current time, as epoch ms (see `useWatchParty().getServerNow`).
 * @returns {number} The position the local player should be at, in seconds.
 */
export function computeWatchPartyEffectivePosition(playback, serverNowMs) {
  if (playback.status !== 'playing') {
    return playback.positionSeconds
  }
  // A payload with no `serverTime` (EMPTY_PLAYBACK before the first snapshot)
  // cannot be advanced safely, so it is taken at face value.
  if (!playback.serverTime) {
    return playback.positionSeconds
  }
  const elapsed = (serverNowMs - new Date(playback.serverTime).getTime()) / 1000
  return playback.positionSeconds + Math.max(0, elapsed)
}

/**
 * Clamps a value into a range.
 *
 * @param {number} value Value to clamp.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @returns {number} The clamped value.
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Keeps a VideoPlayer following a Watch Party's server-authoritative playback
 * clock, and mediates in the other direction too: the returned handlers turn the
 * member's own play/pause/scrub into session commands while suppressing the echo
 * of this hook's own corrections. Shared by WatchPartyPage and
 * WatchPartyDisplayPage so both behave identically.
 *
 * Correction is banded - ignore, nudge playbackRate, or seek - because a hard
 * seek is the only visible kind: it jumps the picture and re-requests the byte
 * range. Small drift is therefore absorbed by playing imperceptibly fast or
 * slow, and seeking is reserved for gaps too large to close that way. The hook
 * owns `playbackRate` for as long as the session lasts, so a speed chosen from
 * the browser's own controls menu will be overridden - unavoidable when every
 * member has to stay on the same frame.
 *
 * All of that is suspended while `getState().remote` reports a receiver is
 * rendering (AirPlay, Chromecast): there the correction is worse than the drift,
 * so only a gap of several seconds earns a seek and the rate is never touched.
 *
 * @param {{current: {play: Function, pause: Function, seek: Function, setPlaybackRate: Function, getState: Function}|null}} videoPlayerRef Ref to the VideoPlayer's imperative handle.
 * @param {object|null} nowPlaying `useWatchParty().nowPlaying`.
 * @param {{status: string, positionSeconds: number, serverTime: string|null, updatedAt: string|null}} playback `useWatchParty().playback`.
 * @param {{play: Function, pause: Function, seek: Function, getServerNow: Function}} commands Session commands from `useWatchParty()`.
 * @returns {{onPlaybackIntent: (paused: boolean) => void, onSeekIntent: (seconds: number) => void}} Handlers to pass to VideoPlayer.
 */
export function useWatchPartyPlaybackSync(videoPlayerRef, nowPlaying, playback, commands) {
  const lastVideoIdRef = useRef(null)
  const seekCooldownUntilRef = useRef(0)
  const localIntentUntilRef = useRef(0)
  const appliedRateRef = useRef(1)
  // Whether a rate nudge is currently in effect, which selects the wider exit
  // threshold below - see RESYNC_EXIT_BAND_SECONDS.
  const nudgingRef = useRef(false)

  // The evaluation loop below runs on a timer, so it reads the latest playback
  // state and commands from refs instead of being torn down and restarted every
  // time a tick arrives. Mirrored in an effect (rather than assigned during
  // render) because a ref write during render is not safe under concurrent
  // rendering - the render may be thrown away.
  const playbackRef = useRef(playback)
  const nowPlayingRef = useRef(nowPlaying)
  const commandsRef = useRef(commands)
  useEffect(() => {
    playbackRef.current = playback
    nowPlayingRef.current = nowPlaying
    commandsRef.current = commands
  })

  /**
   * Applies a playback rate, if it is not already the one in effect.
   *
   * @param {number} rate The rate to apply.
   * @returns {void}
   */
  const applyRate = useCallback((rate) => {
    if (Math.abs(appliedRateRef.current - rate) < 0.005) {
      return
    }
    appliedRateRef.current = rate
    videoPlayerRef.current?.setPlaybackRate?.(rate)
  }, [videoPlayerRef])

  /**
   * Seeks the element and opens the cooldown window, so the next few
   * evaluations leave it alone while it buffers at the new position.
   *
   * @param {number} target Position to seek to, in seconds.
   * @param {boolean} shouldPlay Whether to play after seeking.
   * @param {number} [cooldownMs] How long to leave the element alone afterwards; a remote receiver needs longer than a local element to settle.
   * @returns {void}
   */
  const hardSeek = useCallback((target, shouldPlay, cooldownMs = SEEK_COOLDOWN_MS) => {
    applyRate(1)
    nudgingRef.current = false
    seekCooldownUntilRef.current = Date.now() + cooldownMs
    videoPlayerRef.current?.seek(target, { play: shouldPlay })
  }, [applyRate, videoPlayerRef])

  // Video changed (or first loaded): jump straight to the server clock and match
  // its play/pause state. VideoPlayer's <video> remounts (key={memoizedSrc})
  // when its `video` prop changes, so this seek is likely queued (see
  // VideoPlayer's seek()) until metadata loads.
  useEffect(() => {
    const videoId = nowPlaying?.video?.videoId
    if (!videoId || videoId === lastVideoIdRef.current) {
      return
    }
    lastVideoIdRef.current = videoId
    // Put the rate back explicitly rather than just assuming the new element
    // starts at 1: VideoPlayer re-applies the last rate it was given after a
    // remount, so leaving a nudge in place there would strand it permanently -
    // the dead band's applyRate(1) would think it had nothing to do.
    appliedRateRef.current = 1
    nudgingRef.current = false
    videoPlayerRef.current?.setPlaybackRate?.(1)
    hardSeek(
      computeWatchPartyEffectivePosition(playback, commands.getServerNow()),
      playback.status === 'playing',
    )
    // Only re-run when the video itself changes - the loop below handles ongoing
    // playback updates for the same video.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowPlaying?.video?.videoId])

  useEffect(() => {
    const interval = setInterval(() => {
      const currentNowPlaying = nowPlayingRef.current
      const currentPlayback = playbackRef.current
      if (!currentNowPlaying) {
        return
      }
      const state = videoPlayerRef.current?.getState()
      if (!state) {
        return
      }

      const now = Date.now()
      if (now < localIntentUntilRef.current) {
        return
      }
      // Mid-seek or starved of data, the element cannot honour anything asked of
      // it - and its currentTime is not meaningful to measure against either.
      if (state.seeking || (state.readyState ?? 0) < MIN_READY_STATE) {
        return
      }

      const target = computeWatchPartyEffectivePosition(
        currentPlayback,
        commandsRef.current.getServerNow(),
      )
      const drift = state.currentTime - target

      if (currentPlayback.status === 'paused') {
        applyRate(1)
        nudgingRef.current = false
        if (!state.paused) {
          videoPlayerRef.current?.pause()
        }
        // Pausing itself still propagates to a receiver; it's only the position
        // correction that costs a re-sync, so that takes the remote threshold.
        const pausedThreshold = state.remote
          ? REMOTE_SEEK_THRESHOLD_SECONDS
          : PAUSED_SEEK_THRESHOLD_SECONDS
        if (Math.abs(drift) > pausedThreshold && now >= seekCooldownUntilRef.current) {
          hardSeek(target, false, state.remote ? REMOTE_SEEK_COOLDOWN_MS : SEEK_COOLDOWN_MS)
        }
        return
      }

      // Server says playing. Start it if it is not - WatchPartyDisplayPage
      // watches for the rejection separately to show its "click to enable"
      // overlay, so any failure here is deliberately swallowed.
      if (state.paused) {
        applyRate(1)
        videoPlayerRef.current?.play()?.catch(() => {})
        return
      }

      const magnitude = Math.abs(drift)

      // A receiver is rendering: hands off the rate entirely, and only step in
      // for a gap that cannot be explained by its buffer. See REMOTE_* above.
      if (state.remote) {
        applyRate(1)
        nudgingRef.current = false
        if (magnitude > REMOTE_SEEK_THRESHOLD_SECONDS && now >= seekCooldownUntilRef.current) {
          hardSeek(target, true, REMOTE_SEEK_COOLDOWN_MS)
        }
        return
      }

      // Asymmetric band: 0.25s to start nudging, 0.1s to stop - see
      // RESYNC_EXIT_BAND_SECONDS for why they must not be the same number.
      const returnBand = nudgingRef.current ? RESYNC_EXIT_BAND_SECONDS : DEAD_BAND_SECONDS
      if (magnitude <= returnBand) {
        applyRate(1)
        nudgingRef.current = false
        return
      }
      if (magnitude <= SOFT_BAND_SECONDS) {
        // Behind the server (drift < 0) means play slightly faster.
        nudgingRef.current = true
        applyRate(1 - clamp(drift * RATE_GAIN, -MAX_RATE_ADJUST, MAX_RATE_ADJUST))
        return
      }
      if (now >= seekCooldownUntilRef.current) {
        hardSeek(target, true)
      }
    }, EVALUATE_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [applyRate, hardSeek, videoPlayerRef])

  // Put the rate back when this hook stops driving the element, so a session
  // leftover cannot follow the user onto an ordinary watch page.
  useEffect(() => () => {
    if (appliedRateRef.current !== 1) {
      videoPlayerRef.current?.setPlaybackRate?.(1)
    }
  }, [videoPlayerRef])

  /**
   * Turns a play/pause from the player's own controls into a session command, so
   * the transport rail is not the only thing that works. Any member may control
   * playback (controlPlayback enforces no ownership), matching the rail's
   * ungated buttons.
   *
   * Only acts when the local element has diverged from the server clock: when
   * this hook plays or pauses the element to follow the session, the resulting
   * event already agrees with `playback`, so nothing is emitted and there is no
   * feedback loop.
   *
   * @param {boolean} paused The element's new paused state.
   * @returns {void}
   */
  const onPlaybackIntent = useCallback((paused) => {
    const currentPlayback = playbackRef.current
    if (paused && currentPlayback.status === 'playing') {
      localIntentUntilRef.current = Date.now() + LOCAL_INTENT_GRACE_MS
      commandsRef.current.pause().catch(() => {})
    } else if (!paused && currentPlayback.status === 'paused') {
      localIntentUntilRef.current = Date.now() + LOCAL_INTENT_GRACE_MS
      commandsRef.current.play().catch(() => {})
    }
  }, [])

  /**
   * Turns the member's own scrub into a session seek, moving everyone together.
   * VideoPlayer only reports seeks it did not make itself, so this hook's own
   * corrections cannot come back round as session-wide seeks.
   *
   * @param {number} seconds The position the user scrubbed to.
   * @returns {void}
   */
  const onSeekIntent = useCallback((seconds) => {
    if (!Number.isFinite(seconds)) {
      return
    }
    // Hold off correction until the server's answer arrives - the round trip is
    // long enough that the old position would otherwise pull them back.
    localIntentUntilRef.current = Date.now() + LOCAL_INTENT_GRACE_MS
    applyRate(1)
    commandsRef.current.seek(seconds).catch(() => {})
  }, [applyRate])

  return { onPlaybackIntent, onSeekIntent }
}
