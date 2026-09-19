import { useEffect, useRef } from 'react'

// Local player position is only hard-corrected once it drifts from the
// server clock by more than this, so small natural jitter (buffering,
// tick timing) doesn't cause a visible stutter on every tick.
const DRIFT_THRESHOLD_SECONDS = 1.5

/**
 * Computes the server clock's current effective position, mirroring
 * webapi's lib/cast/queue-service.js `effectivePosition` - the stored
 * position plus elapsed wall-clock time since it was last updated, while playing.
 * @param {{status: string, positionSeconds: number, updatedAt: string|null}} playback
 * @returns {number}
 */
export function computeWatchPartyEffectivePosition(playback) {
  if (playback.status !== 'playing' || !playback.updatedAt) {
    return playback.positionSeconds
  }
  const elapsed = (Date.now() - new Date(playback.updatedAt).getTime()) / 1000
  return playback.positionSeconds + Math.max(0, elapsed)
}

/**
 * Drives a VideoPlayer imperative-handle ref to follow a Watch Party's
 * server-authoritative playback clock: a full seek/load when `nowPlaying`
 * changes video, and periodic drift correction while the same video keeps
 * playing. Shared by WatchPartyPage and WatchPartyDisplayPage so both stay in
 * sync the same way.
 * @param {{current: {play: Function, pause: Function, seek: Function, getState: Function}|null}} videoPlayerRef
 * @param {object|null} nowPlaying `useWatchParty().nowPlaying`.
 * @param {{status: string, positionSeconds: number, updatedAt: string|null}} playback `useWatchParty().playback`.
 */
export function useWatchPartyPlaybackSync(videoPlayerRef, nowPlaying, playback) {
  const lastVideoIdRef = useRef(null)

  // Video changed (or first loaded): (re)seek to the server clock and match
  // its play/pause state. VideoPlayer's internal <video> element remounts
  // (key={memoizedSrc}) when its `video` prop changes, so this seek is
  // likely queued (see VideoPlayer's seek()) until metadata loads.
  useEffect(() => {
    const videoId = nowPlaying?.video?.videoId
    if (!videoId || videoId === lastVideoIdRef.current) {
      return
    }
    lastVideoIdRef.current = videoId
    videoPlayerRef.current?.seek(computeWatchPartyEffectivePosition(playback), {
      play: playback.status === 'playing',
    })
    // Only re-run when the video itself changes - the effect below handles
    // ongoing playback updates for the same video.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowPlaying?.video?.videoId])

  // Drift correction: on every playback update (roughly once a second while
  // playing, per lib/cast/realtime.js's tick), compare the local player's
  // actual position/pause-state against the server clock and correct if
  // they've meaningfully diverged.
  useEffect(() => {
    if (!nowPlaying) {
      return
    }
    const state = videoPlayerRef.current?.getState()
    if (!state) {
      return
    }
    const target = computeWatchPartyEffectivePosition(playback)
    if (Math.abs(state.currentTime - target) > DRIFT_THRESHOLD_SECONDS) {
      videoPlayerRef.current?.seek(target, { play: playback.status === 'playing' })
    } else if (playback.status === 'playing' && state.paused) {
      // Swallowed here (unlike the page-level autoplay-block detection in
      // WatchPartyDisplayPage) - this hook has no UI of its own to react with.
      videoPlayerRef.current?.play()?.catch(() => {})
    } else if (playback.status === 'paused' && !state.paused) {
      videoPlayerRef.current?.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback, nowPlaying])
}
