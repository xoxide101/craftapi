// Upstreams the proxy may reach. A key may override baseUrl only for providers with allowBaseUrl (local servers).
export const PROVIDERS = {
  ollama: { baseUrl: 'http://127.0.0.1:11434', allowBaseUrl: true, keyOptional: true, auth: (k) => (k ? { authorization: `Bearer ${k}` } : {}) },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com', auth: (k) => ({ 'x-goog-api-key': k }) },
  openai: { baseUrl: 'https://api.openai.com', auth: (k) => ({ authorization: `Bearer ${k}` }) },
  anthropic: { baseUrl: 'https://api.anthropic.com', auth: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
  custom: { baseUrl: null, allowBaseUrl: true, keyOptional: true, auth: (k) => (k ? { authorization: `Bearer ${k}` } : {}) },
};
