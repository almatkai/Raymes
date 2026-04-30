# Security & Privacy

SuperCmd occupies a central role in your workflow — it sees your keystrokes, clipboard, voice input, and AI prompts. This document explains exactly what the app monitors and what data leaves your device.

---

## What This Document Covers

- [Data Collected & Telemetry](#data-collected--telemetry)
- [What Leaves Your Device](#what-leaves-your-device)
- [Privacy Options](#privacy-options)
- [API Key & Secret Storage](#api-key--secret-storage)
- [Extension Security](#extension-security)
- [Electron Security Architecture](#electron-security-architecture)
- [Known Limitations](#known-limitations)
- [Reporting a Vulnerability](#reporting-a-vulnerability)

---

## Data Collected & Telemetry

SuperCmd uses [Aptabase](https://aptabase.com/) for analytics. Their server is located in the US (`A-US-*` app ID).

| Event | Data sent | When |
|---|---|---|
| `app_started` | App version, OS version, anonymous session ID | Every app launch |

### Extension Install/Uninstall Reporting

When you install or uninstall an extension, the following is sent to `https://api.supercmd.sh`:

- Extension name (e.g. `raycast/github`)
- An **anonymous machine ID** — a randomly generated hex string stored at `~/Library/Application Support/SuperCmd/.machine-id`

This is used for install/download count metrics on the extension catalog.

---

## What Leaves Your Device

| Destination | What is sent | When | Controlled by |
|---|---|---|---|
| `https://api.supercmd.sh` | Extension name + anonymous machine ID | On extension install/uninstall | Extension store usage |
| `https://api.supercmd.sh` | Extension name | When browsing the extension catalog | Extension store usage |
| Your configured AI provider (OpenAI / Anthropic / Gemini / custom) | Your prompt + system prompt | When you use AI features | AI settings |
| `http://localhost:11434` | Your prompt | When using Ollama | AI settings (local) |
| `https://api.elevenlabs.io` | Text to be spoken | When using ElevenLabs TTS | TTS settings |
| Edge TTS (`speech.platform.bing.com`) | Text to be spoken | When using built-in Edge TTS | TTS settings |
| `https://api.supermemory.ai` | Memory snippets (up to ~2,400 chars) | When Supermemory integration is enabled | Memory settings |
| GitHub Releases API | App version string | On auto-update check | Built-in updater |
| Extension CDN / S3 | Binary download | On extension install | Extension store usage |

---

## Privacy Options

### Disable Analytics (Aptabase)

There is currently **no in-app toggle** for the `app_started` telemetry event. To block it:

**Option 1 — Block via hosts file:**
```bash
echo "127.0.0.1 eu.aptabase.com us.aptabase.com" | sudo tee -a /etc/hosts
```

**Option 2 — Build from source with analytics removed:**
In `src/main/main.ts`, remove or comment out:
```typescript
import { initialize as initAptabase, trackEvent } from "@aptabase/electron/main";
// ...
initAptabase("A-US-7660732429");   // line ~10547
// ...
trackEvent("app_started");          // line ~10566
```
Then `npm run build && npm run package`.

> We plan to add a proper opt-out toggle in the Settings UI. Track progress at [SuperCmdLabs/SuperCmd#telemetry-opt-out](https://github.com/SuperCmdLabs/SuperCmd/issues).

### Disable Extension Install Reporting

To opt out of install/uninstall reporting:

1. Delete `~/Library/Application Support/SuperCmd/.machine-id` to discard the current anonymous ID.
2. Build from source and remove the `reportInstall()` / `reportUninstall()` calls in `src/main/extension-api.ts`.

### Disable Clipboard History

Go to **Settings → General** and disable **Clipboard History**, or delete the stored history:
```bash
rm -rf ~/Library/Application\ Support/SuperCmd/clipboard-history/
```

### Use Local AI

Set your AI provider to **Ollama** with a local model. All AI processing stays on-device.

### Use Local Memory

Leave `supermemoryApiKey` blank. SuperCmd will fall back to `local-memories.json` on your device.

### Use Native STT

Set `speechToTextModel` to `native` in AI settings. This uses Apple's on-device speech recognizer.

---

## API Key & Secret Storage

API keys (OpenAI, Anthropic, Gemini, ElevenLabs, Supermemory) are stored in **plain text** in:

```
~/Library/Application Support/SuperCmd/settings.json
```

- The file is readable by your user account and any process running as you.
- macOS Time Machine backups will include this file.
- Any extension running inside SuperCmd can request a file read via IPC.

**Mitigations until keychain storage is implemented:**
- Keep your device screen locked when unattended.
- Exclude `~/Library/Application Support/SuperCmd/` from Time Machine if you're concerned about backup exposure.
- Use read-only API keys with minimal permissions where your provider allows it.

> Using the OS keychain for secret storage is on our roadmap.

---

## Extension Security

Extensions run as JavaScript bundles inside the renderer process, with access to SuperCmd's IPC bridge. An extension can:

- Read and write files on your behalf
- Execute AppleScript
- Make network requests
- Read settings (including other extensions' preferences)

**Mitigations:**
- Extensions in the SuperCmd store are sourced from the public [Raycast extension registry](https://github.com/raycast/extensions), which is open-source and community-reviewed.
- Extension bundles are pre-built with esbuild — no `eval()` or dynamic code generation at runtime.
- `contextIsolation: true` and `nodeIntegration: false` are enforced on all windows.

Treat installing an extension like installing any other macOS app — it runs with your user's permissions.

**Per-extension sandboxing (capability restrictions) is not yet implemented.**

---

## Electron Security Architecture

| Control | Status | Notes |
|---|---|---|
| `contextIsolation: true` | ✅ Enabled on all windows | Renderer cannot access Node.js directly |
| `nodeIntegration: false` | ✅ Enabled on all windows | Node APIs not exposed to renderer |
| `contextBridge` preload | ✅ Used correctly | Only explicit IPC surface is exposed |
| `sandbox: true` | ⚠️ Partial | Enabled on overlay windows; not on main windows |
| Content Security Policy | ⚠️ Not enforced | `sc-asset://` protocol has `bypassCSP: true` for extension assets |
| IPC sender validation | ⚠️ Not implemented | Relies on Electron's isolation boundary |
| Hardened Runtime | ✅ Enabled | macOS notarization with hardened runtime |
| HTTPS for all remote calls | ✅ | All external endpoints use TLS; Ollama is localhost |

---

## Known Limitations

1. **No telemetry opt-out UI** — must block at the network level or build from source.
2. **API keys stored in plain text** — not using macOS Keychain yet.
3. **No per-extension sandboxing** — all extensions share the same IPC surface.
4. **IPC handlers lack sender validation** — relies on Electron's process isolation.
5. **CSP bypass for asset protocol** — `sc-asset://` bypasses Content Security Policy to serve extension images.

---

## Reporting a Vulnerability

If you discover a security issue, **please do not open a public GitHub issue.**

Report privately via:
- **GitHub Security Advisories**: [https://github.com/SuperCmdLabs/SuperCmd/security/advisories/new](https://github.com/SuperCmdLabs/SuperCmd/security/advisories/new)
- **Email**: security@supercmd.sh

Please include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any proof-of-concept code (if applicable)

We aim to acknowledge reports within 48 hours and provide a fix timeline within 7 days for critical issues.
