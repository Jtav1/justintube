let castSdkPromise = null

/**
 * Loads the Google Cast Web Sender SDK once per page load and initializes
 * CastContext against the built-in Default Media Receiver, so any video URL
 * can be cast without registering a custom receiver app. Chrome/Edge only -
 * the SDK calls back with `isAvailable: false` (or the script simply never
 * loads) in browsers with no Cast implementation.
 *
 * This is deliberately more reliable than the generic W3C Remote Playback
 * API (`HTMLMediaElement.remote`): it's Google's own actively-maintained,
 * Chromecast-specific discovery/session mechanism - the same one YouTube,
 * Netflix, etc. use in-browser - rather than the cross-vendor standard
 * Chrome's own device-matching for arbitrary media flinging is known to
 * handle unreliably.
 *
 * Safe to call from multiple components mounted at once (e.g. navigating
 * between videos re-mounts the player): later calls reuse the same
 * in-flight/settled load instead of re-injecting the script or clobbering an
 * earlier caller's `window.__onGCastApiAvailable` callback.
 *
 * @returns {Promise<boolean>} True once `window.cast.framework` is ready to use.
 */
export function loadCastSdk() {
  if (castSdkPromise) {
    return castSdkPromise
  }
  castSdkPromise = new Promise((resolve) => {
    if (window.chrome?.cast?.isAvailable) {
      resolve(true)
      return
    }
    window['__onGCastApiAvailable'] = (isAvailable) => {
      if (!isAvailable) {
        resolve(false)
        return
      }
      window.cast.framework.CastContext.getInstance().setOptions({
        receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      })
      resolve(true)
    }
    const script = document.createElement('script')
    // loadCastFramework=1 is required to get cast.framework (the modern
    // session-oriented API) alongside the base chrome.cast API - without it
    // window.cast.framework is left undefined even once isAvailable is true.
    script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'
    script.async = true
    script.onerror = () => resolve(false)
    document.head.appendChild(script)
  })
  return castSdkPromise
}
