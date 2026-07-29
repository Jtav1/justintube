import axios from 'axios'

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000',
  withCredentials: true,
})

let csrfToken = null

export function getCsrfToken() {
  return csrfToken
}

export function setCsrfToken(token) {
  csrfToken = token
}

apiClient.interceptors.request.use((config) => {
  if (csrfToken && config.method && config.method.toLowerCase() !== 'get') {
    config.headers['X-CSRF-Token'] = csrfToken
  }
  return config
})

export default apiClient
