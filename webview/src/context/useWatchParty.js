import { useContext } from 'react'
import { WatchPartyContext } from './watch-party-context.js'

export function useWatchParty() {
  const context = useContext(WatchPartyContext)
  if (!context) {
    throw new Error('useWatchParty must be used within a WatchPartyProvider')
  }
  return context
}
