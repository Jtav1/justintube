import axios from "axios";

const apiBaseURL =
  window.__RUNTIME_CONFIG__?.API_BASE_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  "http://localhost:3000";

const apiClient = axios.create({
  baseURL: apiBaseURL,
  withCredentials: true,
});

let csrfToken = null;

export function getCsrfToken() {
  return csrfToken;
}

export function setCsrfToken(token) {
  csrfToken = token;
}

apiClient.interceptors.request.use((config) => {
  if (csrfToken && config.method && config.method.toLowerCase() !== "get") {
    config.headers["X-CSRF-Token"] = csrfToken;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status >= 500) {
      console.error(
        `API 500 error: ${error.config?.method?.toUpperCase()} ${error.config?.url}`,
        error.response.data,
      );
    }
    return Promise.reject(error);
  },
);

export default apiClient;
