// Minimal ESLint flat config for the GEE AI Assistant extension.
// No extra plugins/packages: only core rules and inline globals.

const browserLikeGlobals = {
  console: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  structuredClone: "readonly",
  queueMicrotask: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  fetch: "readonly",
  crypto: "readonly"
};

const extensionGlobals = {
  ...browserLikeGlobals,
  chrome: "readonly"
};

const baseRules = {
  "no-unused-vars": "warn",
  "no-undef": "warn",
  eqeqeq: "warn",
  "no-var": "warn"
};

export default [
  {
    ignores: ["docs/**", "node_modules/**"]
  },
  {
    // ES Modules running in extension contexts (service worker + shared libs).
    files: ["service-worker.js", "lib/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...extensionGlobals,
        self: "readonly",
        Response: "readonly",
        Headers: "readonly",
        ReadableStream: "readonly",
        atob: "readonly",
        btoa: "readonly"
      }
    },
    rules: baseRules
  },
  {
    // Sidepanel UI module.
    files: ["sidepanel.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...extensionGlobals,
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        requestAnimationFrame: "readonly",
        MutationObserver: "readonly",
        CustomEvent: "readonly",
        Event: "readonly",
        KeyboardEvent: "readonly",
        confirm: "readonly"
      }
    },
    rules: baseRules
  },
  {
    // Classic (non-module) injected scripts.
    files: ["page-bridge.js", "content-script.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...extensionGlobals,
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        MutationObserver: "readonly",
        CustomEvent: "readonly"
      }
    },
    rules: baseRules
  },
  {
    // Node-based test suites (ESM .mjs).
    files: ["tests/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...browserLikeGlobals,
        process: "readonly",
        globalThis: "readonly",
        Buffer: "readonly",
        DOMException: "readonly",
        Response: "readonly",
        Headers: "readonly"
      }
    },
    rules: baseRules
  },
  {
    // Config file itself.
    files: ["eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { console: "readonly" }
    },
    rules: baseRules
  }
];
