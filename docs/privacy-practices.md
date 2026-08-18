# Chrome Web Store Privacy practices — paste-ready answers

These answers describe GEE AI Code Assistant v0.4.0 as implemented in the submitted package. Keep the dashboard declarations, public privacy policy, store listing, and extension behavior consistent.

## Single purpose description

Provides an AI coding side panel for Google Earth Engine Code Editor. It reads user-requested editor context, researches official Earth Engine documentation, generates and reviews GEE JavaScript, and applies changes only after the user confirms.

## Permission justifications

### clipboardWrite

Allows the user to copy generated code, Google OAuth redirect URLs, and Earth Engine asset IDs to the clipboard. The extension writes to the clipboard only after the user clicks a copy control.

### Host permissions

Access to `code.earthengine.google.com` connects the side panel to the Earth Engine editor to read user-requested script, selection, and Console context and to apply user-confirmed edits. Access to `api.deepseek.com` sends prompts to the default user-configured AI provider. Access to `developers.google.com/earth-engine` retrieves public Earth Engine documentation and dataset metadata. Access to `earthengine.googleapis.com` lets an authorized user list their own Earth Engine assets and tasks and import a user-selected Shapefile. Optional HTTPS or localhost origins are not granted by default; the extension requests only the origin of a custom model endpoint that the user explicitly saves.

### identity

Opens a Google OAuth authorization flow only after the user configures their own OAuth client ID and requests an Earth Engine REST feature. The resulting Earth Engine access token is stored only in `chrome.storage.session` for the browser session and is sent only to Google Earth Engine APIs.

### sidePanel

Provides the extension's user interface as a Chrome side panel and opens that panel when the user clicks the extension action. The side panel contains the coding conversation, review, settings, asset, and task controls.

### storage

Stores extension settings, tool preferences, conversation history, plans, generated-code review cards, documentation caches, and optional local Shapefile fallback data in the user's browser. API keys are session-only by default and are stored locally only when the user explicitly enables persistent storage. The extension does not use storage for advertising or tracking.

### tabs

Identifies the active Google Earth Engine Code Editor tab, verifies that the user is on `code.earthengine.google.com`, sends messages to the bundled content script, and refreshes editor context after a relevant tab activation or update when workspace connection is enabled. It does not read content from unrelated tabs.

### unlimitedStorage

Prevents loss of user-created conversation history, plans, code-review snapshots, documentation caches, and optional local Shapefile fallback data when they exceed Chrome's normal local-storage quota. The data remains in the user's own browser and is not used for tracking.

## Remote code

Select: **No, I am not using remote code.**

Justification:

All executable JavaScript is included in the extension package. The extension does not load remote scripts or WebAssembly and does not use `eval`, `new Function`, dynamic remote imports, or a remote command interpreter. Network responses are handled as data. AI responses may contain user-requested GEE source text; that text is displayed for review and is never evaluated as extension code. It is inserted into the Earth Engine editor only after explicit user confirmation.

## Data handling declarations

Do not declare that the extension handles no user data. At minimum, its behavior includes these Chrome Web Store data categories:

- **Website content:** Earth Engine script, selection, Console output, script title, and user-selected asset/task context.
- **User-generated content:** prompts, conversations, generated code, plans, and user-selected Shapefile contents.
- **Authentication information:** user-supplied model API keys, Google OAuth client ID, and short-lived Earth Engine OAuth access tokens.

The extension developer operates no collection or relay server and has no access to this data. On the user's action, the extension transmits relevant prompts and selected editor context directly to the model endpoint configured by the user; it sends Earth Engine API requests and selected Shapefiles directly to Google. Public documentation requests go to Google Developers. Data stored by the extension remains in `chrome.storage.local` or `chrome.storage.session` on the user's device.

For the data-usage questions, certify only the practices that match this implementation:

- Data is used only to provide the extension's disclosed Earth Engine coding-assistant features.
- Data is not sold or transferred for advertising, credit, or unrelated purposes.
- Data is not used for personalized advertising.
- The extension developer does not allow humans to read user data.

## Final dashboard steps

1. Save the completed Privacy practices tab with all permission explanations, the remote-code selection, data categories, certification, and the public privacy-policy URL.
2. Open the Developer Dashboard **Settings** page, enter the publisher contact email, request verification, and complete the verification link received by email.
3. Return to the item and save the draft again before publishing.
