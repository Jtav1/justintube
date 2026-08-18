import { useEffect, useState } from 'react'
import { getPublicConfig } from '../api/config.js'
import { SiteConfigContext } from './site-config-context.js'

export function SiteConfigProvider({ children }) {
  const [livestreamEnabled, setLivestreamEnabled] = useState(false)
  // Matches the webapi default (ENABLE_TRANSCODING defaults to true) so the
  // UI doesn't briefly look disabled while this is still loading.
  const [transcodingEnabled, setTranscodingEnabled] = useState(true)
  // Matches the webapi default (ENABLE_CAST defaults to true) for the same reason.
  const [castEnabled, setCastEnabled] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        const config = await getPublicConfig()
        if (!cancelled) {
          setLivestreamEnabled(Boolean(config.livestreamEnabled))
          setTranscodingEnabled(config.transcodingEnabled !== false)
          setCastEnabled(config.castEnabled !== false)
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
      value={{ livestreamEnabled, transcodingEnabled, castEnabled, loading }}
    >
      {children}
    </SiteConfigContext.Provider>
  )
}
