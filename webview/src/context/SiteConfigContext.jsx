import { useEffect, useState } from 'react'
import { getPublicConfig } from '../api/config.js'
import { SiteConfigContext } from './site-config-context.js'

export function SiteConfigProvider({ children }) {
  const [livestreamEnabled, setLivestreamEnabled] = useState(false)
  // Matches the webapi default (ENABLE_TRANSCODING defaults to true) so the
  // UI doesn't briefly look disabled while this is still loading.
  const [transcodingEnabled, setTranscodingEnabled] = useState(true)
  // Matches the webapi default (ENABLE_CAST defaults to true) for the same
  // reason. The wire field is still `castEnabled` (backend naming - see
  // api/config.js), mapped to the Watch Party name on this side.
  const [watchPartyEnabled, setWatchPartyEnabled] = useState(true)
  // Matches the webapi default (ENABLE_DEVICE_CAST defaults to false): server
  // side casting needs hardware on the network, so assume absent until told.
  const [deviceCastEnabled, setDeviceCastEnabled] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        const config = await getPublicConfig()
        if (!cancelled) {
          setLivestreamEnabled(Boolean(config.livestreamEnabled))
          setTranscodingEnabled(config.transcodingEnabled !== false)
          setWatchPartyEnabled(config.castEnabled !== false)
          setDeviceCastEnabled(Boolean(config.deviceCastEnabled))
        }
      } catch (err) {
        console.error('Failed to load site config:', err)
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    bootstrap()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <SiteConfigContext.Provider
      value={{ livestreamEnabled, transcodingEnabled, watchPartyEnabled, deviceCastEnabled, loading }}
    >
      {children}
    </SiteConfigContext.Provider>
  )
}
