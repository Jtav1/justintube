import { useContext } from 'react'
import { CastContext } from './cast-context.js'

export function useCast() {
  const context = useContext(CastContext)
  if (!context) {
    throw new Error('useCast must be used within a CastProvider')
  }
  return context
}
