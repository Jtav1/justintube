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
  async (error) => {
    if (error.response && error.response.status >= 500) {
      console.error(
        `API 500 error: ${error.config?.method?.toUpperCase()} ${error.config?.url}`,
        error.response.data,
      );
    }

    // A 403 csrf_invalid means the in-memory token (module state, so it's
    // lost on a full reload and can also drift if another tab rotated it,
    // e.g. by logging in again) no longer matches the session's current
    // one. Refetch it and retry the request exactly once rather than
    // surfacing a confusing 403 for what's really just a stale local copy -
    // config._csrfRetried guards against looping if the retry also fails.
    const config = error.config;
    if (
      error.response?.status === 403 &&
      error.response?.data?.error === "csrf_invalid" &&
      config &&
      !config._csrfRetried
    ) {
      config._csrfRetried = true;
      try {
        const csrfRes = await apiClient.get("/api/v1/auth/csrf");
        setCsrfToken(csrfRes.data.csrfToken);
        return apiClient(config);
      } catch {
        // Fall through and reject with the original error below.
      }
    }

    return Promise.reject(error);
  },
);

export default apiClient;
