# PromptCast

**One prompt. Every AI. At once.**

Ask once and PromptCast sends your prompt to **ChatGPT, Claude, Gemini, Copilot, DeepSeek, Perplexity and Grok** at the same time, so you compare answers instead of copy-pasting across tabs.

## Features

- **Multicast prompting** — one box, every AI you have switched on.
- **Grid view** — all answers side by side in a single tab. Each cell shows its delivery state: sent, ready, or a human-readable error with a retry button.
- **Verified sends** — the prompt is read back from the editor before anything is submitted. A fill the editor swallowed is never followed by Enter.
- **New tabs mode** — prefer real tabs? They open filed into one Chrome tab group.
- **Follow-up from anywhere** — select text, right-click, Ask PromptCast. Review first or fire directly.
- **Add your own tools** — Mistral, Qwen, Kimi, a self-hosted UI: URL plus input selector, test in one click.
- **Zero-install permissions** — installs with access to no websites. Each provider is granted one origin at a time, withdrawable anytime.
- **Scoped framing** — header stripping for the grid turns on only inside the grid tab, only for the session, and off the moment it closes.
- **Safe reset** — Reset All restores defaults but never deletes your custom providers.
- **Password-safe selection** — password, email and card fields are never captured by the shortcut.
- **Recent prompts** — kept on your device only, clearable anytime.
- **Theme + motion** — system, light, dark, full keyboard access, reduced-motion respected.

## Privacy

No account, no server, no tracking. Prompts go straight from your browser to the AI sites you chose. Permissions are per-origin and revocable from Settings.

## Install

```bash
git clone https://github.com/madebysaira/PromptCast.git
```

1. Open `chrome://extensions/` and turn on **Developer mode**.
2. Click **Load unpacked** and select the cloned folder.
3. Optional: change shortcut keys at `chrome://extensions/shortcuts`.

## Add a provider

Settings → Providers → Add your own. Name, chat URL, and the CSS selector of the chat input. Send a test prompt from the popup. If it lands, the selector is right.

## Development

```bash
npm test   # static checks: fill verification, permissions, manifest guards
```

Load the folder unpacked in Chrome. No build step.

## License

MIT — see [LICENSE](LICENSE).
