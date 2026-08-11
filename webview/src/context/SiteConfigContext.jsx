import { useEffect, useState } from 'react'
import { getPublicConfig } from '../api/config.js'
import { SiteConfigContext } from './site-config-context.js'

export function SiteConfigProvider({ children }) {
  const [livestreamEnabled, setLivestreamEnabled] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        const config = await getPublicConfig()
        if (!cancelled) {
          setLivestreamEnabled(Boolean(config.livestreamEnabled))
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
    <SiteConfigContext.Provider value={{ livestreamEnabled, loading }}>
      {children}
    </SiteConfigContext.Provider>
  )
}
