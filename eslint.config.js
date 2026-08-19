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
  // Undefined globals are the one class of merge-breaking mistakes that must
  // never land, so this stays an error while style rules remain warnings.
  "no-undef": "error",
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
        CustomEvent: "readonly",
        FormData: "readonly",
        Blob: "readonly"
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
        Headers: "readonly",
        FormData: "readonly",
        Blob: "readonly"
      }
    },
    rules: baseRules
  },
  {
    // Node diagnostics containing callbacks evaluated inside extension pages.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...extensionGlobals,
        process: "readonly",
        globalThis: "readonly",
        Buffer: "readonly",
        DOMException: "readonly",
        Response: "readonly",
        Headers: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        document: "readonly",
        location: "readonly"
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
