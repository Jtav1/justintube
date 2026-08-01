import axios from "axios";

const apiBaseURL =
  window.__RUNTIME_CONFIG__?.API_BASE_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  "http://localhost:3000";

console.log("[justintube] API base URL:", apiBaseURL);
console.log(window.__RUNTIME_CONFIG__?.API_BASE_URL);
console.log(import.meta.env.VITE_API_BASE_URL);
console.log("http://localhost:3000");

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

export default apiClient;
