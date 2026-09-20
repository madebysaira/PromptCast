/**
 * ============================================================
 *  PromptCast — Content Script
 * ============================================================
 *
 *  Injected on demand into one AI chat page at a time. It finds the
 *  chat input, fills it with the user's prompt, verifies the fill,
 *  and only then submits.
 *
 *  Why the verify step? A ProseMirror or Quill editor can swallow a
 *  synthetic paste and leave the previous draft in place. Submitting
 *  blind after that sends the WRONG prompt and reports success.
 *  So: fill, read back, compare, and only then press Enter.
 *
 *  Design notes:
 *  - Selector lists are tried in order, most-specific first.
 *  - Generic fallbacks catch site redesigns without an update.
 *  - React/Vue editors need native setters + dispatched events,
 *    not plain `.value =` assignment.
 *  - A node replaced mid-hydration is re-resolved, never filled detached.
 * ============================================================
 */

if (window.PromptCastLoaded) {
  // Already injected — bail out to avoid duplicate listeners.
} else {
window.PromptCastLoaded = true;

// Last-resort selectors when a provider's own selector finds nothing.
const GENERIC_INPUT_FALLBACKS = {
  textarea: 'textarea:not([aria-hidden="true"])',
  contenteditable: '[contenteditable="true"][role="textbox"]:not([aria-hidden="true"]), [contenteditable="true"]:not([aria-hidden="true"])',
  prosemirror: 'div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]:not([aria-hidden="true"])',
};

const GENERIC_BUTTON_FALLBACKS =
  'button[aria-label*="send" i], button[aria-label*="submit" i], [data-testid*="send"], [data-testid*="submit"]';

// ── Selection Extraction (password-safe) ─────────────────────
// Only plain-text fields are read. Password, email, card-number and
// other sensitive inputs are never captured, so a shortcut fired
// inside a login or checkout form cannot ship a credential to AI sites.
const SAFE_INPUT_TYPES = /^(text|search|url|tel)$/i;

function getActiveSelectionText() {
  const activeEl = document.activeElement;
  if (
    activeEl &&
    (activeEl.tagName === "TEXTAREA" ||
      (activeEl.tagName === "INPUT" && SAFE_INPUT_TYPES.test(activeEl.type))) &&
    typeof activeEl.selectionStart === "number" &&
    activeEl.selectionStart !== activeEl.selectionEnd
  ) {
    return activeEl.value.substring(activeEl.selectionStart, activeEl.selectionEnd).trim();
  }
  return (window.getSelection()?.toString() || "").trim();
}

// ── Wait Helpers ─────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// MutationObserver-driven: resolves the instant the element mounts,
// rejects after FIND_TIMEOUT_MS. Never a blind sleep.
function waitForElement(selector, clickable = false) {
  return new Promise((resolve) => {
    const done = (el) => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    };
    const check = () => {
      const el = document.querySelector(selector);
      if (!el) return false;
      if (clickable && (el.disabled || el.getAttribute("aria-disabled") === "true")) return false;
      if (el.offsetParent === null && el.tagName !== "BODY") return false;
      done(el);
      return true;
    };
    const observer = new MutationObserver(() => check());
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, FIND_TIMEOUT_MS);
    check();
  });
}

// ── Fill + Verify ────────────────────────────────────────────
//
// fillAndSubmit returns one of:
//   { ok: true, filled: true, submitted: true }
//   { ok: true, filled: true, submitted: false }   (prefill mode)
//   { ok: false, error }                            (nothing was sent)
//
// The `verified` flag is the point of this file: after filling we read
// the editor back and require the prompt to actually be there. A fill
// the editor swallowed must NEVER be followed by a submit.
async function fillAndSubmit({
  query,
  inputType,
  selector,
  autoSubmit,
  submitType,
  buttonSel,
  waitMs = 0,
}) {
  // 1. Find the input immediately; fall back to generic patterns.
  let matchedSel = selector;
  let element = await waitForElement(selector);
  if (!element) {
    const fallbackSel = GENERIC_INPUT_FALLBACKS[inputType] || GENERIC_INPUT_FALLBACKS.contenteditable;
    matchedSel = fallbackSel;
    element = await waitForElement(fallbackSel);
  }
  if (!element) {
    return { ok: false, error: `Input not found: ${selector}` };
  }

  // 2. Post-detection settle (capped). Hydration may swap the node
  // while we settle, so re-resolve a detached element.
  if (waitMs > 0) {
    await sleep(Math.min(waitMs, SETTLE_CAP_MS));
    if (!element.isConnected) {
      element = (await waitForElement(matchedSel)) || element;
    }
  }

  element.focus();
  await sleep(200);

  // 3. Fill by editor type.
  let filled = false;
  switch (inputType) {
    case "textarea":
      filled = fillTextarea(element, query);
      break;
    case "contenteditable":
      filled = fillContentEditable(element, query);
      break;
    case "prosemirror":
      filled = fillProseMirror(element, query);
      break;
    default:
      filled = fillTextarea(element, query) || fillContentEditable(element, query);
  }
  if (!filled) {
    return { ok: false, error: "Could not fill the input element" };
  }

  // 4. VERIFY: read the editor back. If the prompt is not there, the
  // editor swallowed our fill (stale draft, hydration race) — abort
  // rather than submit the wrong text.
  await sleep(150);
  if (!verifyFill(element, query)) {
    return { ok: false, error: "Fill not verified: editor kept a stale draft, nothing sent" };
  }

  // 5. Submit only on a verified fill.
  if (!autoSubmit) {
    return { ok: true, filled: true, submitted: false };
  }

  if (buttonSel && submitType !== "enter") {
    let btn = await waitForElement(buttonSel, true);
    if (!btn) {
      btn = await waitForElement(GENERIC_BUTTON_FALLBACKS, true);
    }
    if (btn) {
      await sleep(SUBMIT_DELAY);
      await submit(element, submitType, buttonSel);
    } else {
      await submit(element, "enter", null);
    }
  } else {
    await sleep(SUBMIT_DELAY);
    await submit(element, submitType, buttonSel);
  }

  return { ok: true, filled: true, submitted: true, verified: true };
}

// True when the editor's visible text contains the prompt we set.
// Normalizes whitespace because editors reflow text freely.
function verifyFill(el, query) {
  const text = (el.tagName === "TEXTAREA" || el.tagName === "INPUT")
    ? el.value
    : el.innerText || el.textContent || "";
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const have = norm(text);
  const want = norm(query);
  return have.length > 0 && (have.includes(want.slice(0, 60)) || want.includes(have.slice(0, 60)));
}

// ── Input Filling Strategies ─────────────────────────────────

/**
 * Standard textarea/input. Uses the native setter so React's
 * synthetic event system picks up the change.
 */
function fillTextarea(el, query) {
  try {
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const nativeSetter = setter || Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "value")?.set;
    if (setter) {
      setter.call(el, query);
    } else if (nativeSetter) {
      nativeSetter.call(el, query);
    } else {
      el.value = query;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Plain contenteditable (Quill-style). Select-all, paste via
 * insertText, then confirm the text landed.
 */
function fillContentEditable(el, query) {
  try {
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    const ok = document.execCommand("insertText", false, query);
    if (!ok && (!el.textContent || el.textContent.trim() === "")) {
      el.textContent = query;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: query }));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * ProseMirror editors (ChatGPT, Claude, Grok). They ignore plain
 * value assignment, so we simulate a paste, then fall back to
 * direct text + events. The caller verifies afterwards.
 */
function fillProseMirror(el, query) {
  try {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      return fillTextarea(el, query);
    }
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);

    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", query);
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertFromPaste",
        data: query,
        dataTransfer,
      }));
    } catch {
      // DataTransfer constructor missing (older engines) — fall through.
    }

    if (!el.textContent || el.textContent.trim() === "") {
      el.textContent = query;
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: query,
      }));
    }
    return true;
  } catch {
    return fillContentEditable(el, query);
  }
}

// ── Submit Strategies ────────────────────────────────────────
async function submit(inputEl, submitType, buttonSel) {
  switch (submitType) {
    case "button":
      // Await the click so Enter is only a fallback when the button
      // never becomes clickable — otherwise the prompt sends twice.
      if (!(await clickSubmitButton(buttonSel))) pressEnter(inputEl);
      break;
    case "both":
      await clickSubmitButton(buttonSel);
      pressEnter(inputEl);
      break;
    case "enter":
    default:
      pressEnter(inputEl);
      break;
  }
}

function pressEnter(el) {
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
}

async function clickSubmitButton(selector) {
  if (!selector) return false;
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const btn = document.querySelector(selector);
    if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true" && btn.offsetParent !== null) {
      btn.click();
      return true;
    }
    await sleep(100);
  }
  return false;
}

// ── Message Listener ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "fillQuery") {
    fillAndSubmit(msg).then(sendResponse);
    return true; // async response
  }
  if (msg.type === "getSelection") {
    sendResponse({ text: getActiveSelectionText() });
    return false;
  }
  return false;
});

}
