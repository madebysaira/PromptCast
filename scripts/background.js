/**
 * ============================================================
 *  PromptCast — Background Service Worker
 * ============================================================
 *
 *  The brain of the extension:
 *   1. Receives a "multicast" message from the popup or grid
 *   2. Opens one tab per enabled AI provider (or one grid tab)
 *   3. Injects the prompt via the content script
 *   4. Records a per-provider delivery record the UI can render
 *
 *  Provider definitions live in PROVIDERS below. To support a new
 *  chat site, add one entry: no other code changes needed.
 * ============================================================
 */

importScripts("/scripts/constants.js", "/scripts/permissions.js");

// ── Provider Registry ────────────────────────────────────────
//   id          Unique key (used in storage for enable/disable)
//   name        Human-readable label
//   url         Page to open
//   origins     Optional host permissions, requested on first use
//   inputType   "textarea" | "contenteditable" | "prosemirror"
//   selector    CSS selectors for the chat input, specific-first
//   submitType  "enter" | "button" | "both"
//   buttonSel   Selector for the send button (when submitType != enter)
//   waitMs      Post-detection settle window (capped by content script)
//
// NOTE: chat sites redesign often. If a provider stops working,
// updating `selector` / `buttonSel` here usually fixes it.
const PROVIDERS = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    url: "https://chatgpt.com/",
    origins: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
    inputType: "prosemirror",
    selector: '#prompt-textarea, [data-testid="prompt-textarea"], div.ProseMirror[contenteditable="true"]',
    submitType: "button",
    buttonSel: '#composer-submit-button, [data-testid="send-button"], button[aria-label*="send" i]',
    waitMs: 2500,
  },
  {
    id: "claude",
    name: "Claude",
    url: "https://claude.ai/new",
    origins: ["https://claude.ai/*"],
    inputType: "prosemirror",
    selector: 'div.ProseMirror[contenteditable="true"], [data-testid="chat-input"], [contenteditable="true"]',
    submitType: "button",
    buttonSel: 'button[aria-label="Send message"], [aria-label="Send Message"], button[aria-label*="send" i]',
    waitMs: 2500,
  },
  {
    id: "gemini",
    name: "Gemini",
    url: "https://gemini.google.com/app",
    origins: ["https://gemini.google.com/*"],
    inputType: "contenteditable",
    selector: '.ql-editor[contenteditable="true"], [role="textbox"][contenteditable="true"], [contenteditable="true"]',
    submitType: "button",
    buttonSel: 'button[aria-label*="send" i], [data-testid*="send"]',
    waitMs: 2000,
  },
  {
    id: "copilot",
    name: "Copilot",
    url: "https://copilot.microsoft.com/",
    origins: ["https://copilot.microsoft.com/*"],
    inputType: "contenteditable",
    selector: '[contenteditable="true"][role="textbox"], [contenteditable="true"], textarea',
    submitType: "button",
    buttonSel: 'button[type="submit"], button[aria-label*="send" i]',
    waitMs: 2500,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    url: "https://chat.deepseek.com/",
    origins: ["https://chat.deepseek.com/*"],
    inputType: "textarea",
    selector: 'textarea[placeholder], textarea:not([aria-hidden="true"])',
    submitType: "button",
    buttonSel: 'button[type="submit"], button[aria-label*="send" i]',
    waitMs: 2000,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    url: "https://www.perplexity.ai/",
    origins: ["https://www.perplexity.ai/*"],
    inputType: "contenteditable",
    selector: '[contenteditable="true"][role="textbox"], [contenteditable="true"], textarea',
    submitType: "button",
    buttonSel: 'button[type="submit"], button[aria-label*="send" i]',
    waitMs: 2000,
  },
  {
    id: "grok",
    name: "Grok",
    url: "https://grok.com/",
    origins: ["https://grok.com/*"],
    inputType: "prosemirror",
    selector: 'div.ProseMirror[contenteditable="true"], [contenteditable="true"], textarea',
    submitType: "button",
    buttonSel: 'button[type="submit"], button[aria-label*="send" i]',
    waitMs: 2000,
  },
];

const providerById = (id) => PROVIDERS.find((p) => p.id === id);

// Human-written delivery states. Every send ends in exactly one of
// these per provider, and the grid renders all of them — success is
// never the absence of an error message.
const DELIVERY = {
  SENT: "sent",
  PREFILLED: "prefilled",       // auto-submit off; prompt waiting in the box
  NO_PERMISSION: "no-permission",
  INPUT_MISSING: "input-missing",
  FILL_UNVERIFIED: "fill-unverified", // editor kept a stale draft; nothing sent
  TIMED_OUT: "timed-out",
};

const DELIVERY_COPY = {
  [DELIVERY.SENT]: "Prompt sent.",
  [DELIVERY.PREFILLED]: "Prompt ready in the box. Press Enter there to send.",
  [DELIVERY.NO_PERMISSION]: "Site access not granted. Enable it in Settings.",
  [DELIVERY.INPUT_MISSING]: "Could not find the chat box. The site may have redesigned.",
  [DELIVERY.FILL_UNVERIFIED]: "The editor did not take the prompt, so nothing was sent. Try again.",
  [DELIVERY.TIMED_OUT]: "The page took too long. The tab is still open if you want to send by hand.",
};

// ── Grid DNR rules: scoped, session-only ─────────────────────
//
// Frame-blocking headers are stripped ONLY inside the grid tab,
// ONLY while a session is active, and restored the moment it ends.
// There is no standing header modification at install or otherwise.
const DNR_RULESET_ID = "grid_headers";
let dnrActiveTab = null;

async function enableGridRules(tabId) {
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [DNR_RULESET_ID],
    });
    dnrActiveTab = tabId;
  } catch {
    // Ruleset missing (side-loaded dev tree) — grid still works for
    // providers that allow framing; others open in tabs mode.
  }
}

async function disableGridRules() {
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: [DNR_RULESET_ID],
    });
  } catch {
    // Already off; nothing to do.
  }
  dnrActiveTab = null;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === dnrActiveTab) disableGridRules();
});

// ── Multicast ────────────────────────────────────────────────
//
// Sends `query` to every provider in `providerIds` (or all enabled).
// Returns { results: [{ providerId, state, detail }] } — one record
// per provider, so the caller can render a complete failure surface.
async function multicast(query, opts = {}) {
  const { autoSubmit = true, providerIds = null, groupTabs = true } = opts;
  const settings = (await chrome.storage.sync.get("settings")).settings || {};
  const enabled = settings.enabledProviders || PROVIDERS.map((p) => p.id);
  const custom = settings.customProviders || [];
  const targets = (providerIds || enabled)
    .map((id) => providerById(id) || custom.find((c) => c.id === id))
    .filter(Boolean);

  const results = await Promise.all(targets.map((p) => deliverToProvider(p, query, autoSubmit)));

  if (groupTabs) {
    const tabIds = results.filter((r) => r.tabId).map((r) => r.tabId);
    if (tabIds.length > 1) {
      try {
        const groupId = await chrome.tabs.group({ tabIds });
        await chrome.tabGroups.update(groupId, { title: "PromptCast", color: "blue" });
      } catch {
        // Tab grouping is cosmetic; a failure here changes nothing.
      }
    }
  }
  return { results: results.map(({ tabId: _t, ...rest }) => rest) };
}

// One provider, one tab, one delivery record. Every exit path below
// resolves (never rejects) with a DELIVERY state.
async function deliverToProvider(provider, query, autoSubmit) {
  // 1. Origin permission first — never open a tab we cannot write to.
  if (!(await ensureOrigins(provider.origins))) {
    return { providerId: provider.id, state: DELIVERY.NO_PERMISSION, detail: DELIVERY_COPY[DELIVERY.NO_PERMISSION] };
  }

  // 2. Open the tab.
  let tab;
  try {
    tab = await chrome.tabs.create({ url: provider.url, active: false });
  } catch (e) {
    return { providerId: provider.id, state: DELIVERY.TIMED_OUT, detail: String(e?.message || e) };
  }

  try {
    // 3. Wait for load (bounded), then inject + fill with a budget.
    await waitForTabLoad(tab.id, SERVICE_TIMEOUT_MS);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["/scripts/content.js"],
    });
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "fillQuery",
      query,
      inputType: provider.inputType,
      selector: provider.selector,
      autoSubmit,
      submitType: provider.submitType,
      buttonSel: provider.buttonSel,
      waitMs: provider.waitMs,
    }).catch(() => null);

    if (!response || !response.ok) {
      const state = response?.error?.includes("not verified")
        ? DELIVERY.FILL_UNVERIFIED
        : DELIVERY.INPUT_MISSING;
      return { providerId: provider.id, state, detail: response?.error || DELIVERY_COPY[state], tabId: tab.id };
    }
    if (response.submitted) {
      return { providerId: provider.id, state: DELIVERY.SENT, detail: DELIVERY_COPY[DELIVERY.SENT], tabId: tab.id };
    }
    return { providerId: provider.id, state: DELIVERY.PREFILLED, detail: DELIVERY_COPY[DELIVERY.PREFILLED], tabId: tab.id };
  } catch (e) {
    return { providerId: provider.id, state: DELIVERY.TIMED_OUT, detail: String(e?.message || e), tabId: tab?.id };
  }
}

function waitForTabLoad(tabId, budgetMs) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      chrome.webNavigation.onCompleted.removeListener(listener);
      reject(new Error("Page load timed out"));
    }, budgetMs);
    const listener = (details) => {
      if (details.tabId === tabId && details.frameId === 0) {
        clearTimeout(deadline);
        chrome.webNavigation.onCompleted.removeListener(listener);
        resolve();
      }
    };
    chrome.webNavigation.onCompleted.addListener(listener);
  });
}

// ── Context menu + shortcuts ─────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ask-promptcast",
    title: "Ask PromptCast",
    contexts: ["selection", "page"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "ask-promptcast") return;
  const text = (info.selectionText || "").trim();
  const settings = (await chrome.storage.sync.get("settings")).settings || {};
  if (settings.askDirect && text) {
    await multicast(text, { autoSubmit: true });
  } else {
    // Open the composer with the selection prefilled for review.
    await chrome.storage.session.set({ pendingPrompt: text });
    chrome.action.openPopup?.().catch(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL("pages/popup.html") });
    });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "ask-selection") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const res = await chrome.tabs.sendMessage(tab.id, { type: "getSelection" }).catch(() => null);
    const text = (res?.text || "").trim();
    await chrome.storage.session.set({ pendingPrompt: text });
    chrome.action.openPopup?.().catch(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL("pages/popup.html") });
    });
  }
});

// ── Popup / grid messages ────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "multicast") {
    multicast(msg.query, msg.opts).then(sendResponse);
    return true;
  }
  if (msg.type === "gridRulesOn") {
    enableGridRules(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "gridRulesOff") {
    disableGridRules().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
