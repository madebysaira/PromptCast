/**
 * ============================================================
 *  PromptCast — In-page Overlay Composer
 * ============================================================
 *
 *  The floating prompt panel behind Ctrl+Shift+X ("open anywhere").
 *  Renders inside a CLOSED shadow root so host-page styles never
 *  leak in or out. Loaded on demand by the background worker via
 *  scripting.executeScript + scripting.insertCSS — never a static
 *  content script, so idle pages carry zero PromptCast code.
 *
 *  Message from worker: { type: "openOverlay", prefill }
 *  Reply on send: dispatched to the worker as { type: "multicast" }
 *  via runtime.sendMessage, same path as the popup.
 * ============================================================
 */
(function () {
  if (window.__promptcastOverlayOpen) {
    window.__promptcastOverlayToggle?.();
    return;
  }
  window.__promptcastOverlayOpen = true;

  const KNOWN = ["chatgpt", "claude", "gemini", "copilot", "deepseek", "perplexity", "grok"];

  const host = document.createElement("div");
  host.id = "promptcast-overlay-host";
  host.style.cssText = "position:fixed;right:24px;bottom:24px;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });

  // Panel styling inline: shadow DOM cannot @import extension CSS
  // without an extra fetch, and self-containment keeps injection to
  // one executeScript call.
  const style = document.createElement("style");
  style.textContent = `
    .pc-panel { width: 360px; background: #15151d; color: #f4f4f6;
      border: 1px solid #2a2a38; border-radius: 14px; padding: 16px;
      font: 14px/1.5 system-ui, sans-serif; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
    .pc-panel textarea { width: 100%; box-sizing: border-box; background: #0e0e14;
      color: #f4f4f6; border: 1px solid #2a2a38; border-radius: 10px;
      padding: 10px; font: inherit; resize: vertical; }
    .pc-row { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
    .pc-row button { background: #2f7bff; color: #fff; border: 0; border-radius: 8px;
      padding: 8px 16px; font: inherit; cursor: pointer; }
    .pc-row button.ghost { background: transparent; color: #9a9aad; border: 1px solid #2a2a38; }
    .pc-status { margin-top: 8px; min-height: 20px; color: #9a9aad; font-size: 13px; }
    .pc-providers { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 8px; font-size: 13px; }
    .pc-providers label { display: flex; gap: 4px; align-items: center; cursor: pointer; }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  `;

  const panel = document.createElement("div");
  panel.className = "pc-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "PromptCast composer");

  const box = document.createElement("textarea");
  box.rows = 4;
  box.placeholder = "Ask every AI at once…";
  box.setAttribute("aria-label", "Prompt");

  const provWrap = document.createElement("div");
  provWrap.className = "pc-providers";

  const row = document.createElement("div");
  row.className = "pc-row";
  const send = document.createElement("button");
  send.textContent = "Send to all";
  const grid = document.createElement("button");
  grid.textContent = "Grid";
  grid.className = "ghost";
  const close = document.createElement("button");
  close.textContent = "Close";
  close.className = "ghost";
  row.append(send, grid, close);

  const status = document.createElement("div");
  status.className = "pc-status";
  status.setAttribute("role", "status");

  panel.append(box, provWrap, row, status);
  shadow.append(style, panel);
  document.documentElement.appendChild(host);

  let enabledIds = new Set(KNOWN);
  chrome.storage.sync.get("settings").then(({ settings = {} }) => {
    if (settings.enabledProviders) enabledIds = new Set(settings.enabledProviders);
    const custom = settings.customProviders || [];
    for (const id of [...KNOWN, ...custom.map((c) => c.id)]) {
      const name = custom.find((c) => c.id === id)?.name || (id[0].toUpperCase() + id.slice(1));
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = enabledIds.has(id);
      cb.dataset.provider = id;
      cb.addEventListener("change", () => {
        if (cb.checked) enabledIds.add(id);
        else enabledIds.delete(id);
      });
      label.append(cb, ` ${name}`);
      provWrap.appendChild(label);
    }
  });

  chrome.storage.session.get("pendingPrompt").then(({ pendingPrompt }) => {
    if (pendingPrompt) {
      box.value = pendingPrompt;
      chrome.storage.session.remove("pendingPrompt");
    }
    box.focus();
  });

  // Esc closes; toggling the shortcut re-invokes this file and hits
  // the toggle at the top.
  window.__promptcastOverlayToggle = destroy;
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") destroy();
  });

  function destroy() {
    host.remove();
    window.__promptcastOverlayOpen = false;
    window.__promptcastOverlayToggle = null;
  }

  send.addEventListener("click", async () => {
    const query = box.value.trim();
    if (!query) return;
    const ids = [...provWrap.querySelectorAll("input:checked")].map((b) => b.dataset.provider);
    if (ids.length === 0) {
      status.textContent = "Pick at least one provider.";
      return;
    }
    status.textContent = `Sending to ${ids.length}…`;
    const res = await chrome.runtime.sendMessage({
      type: "multicast", query, opts: { providerIds: ids },
    }).catch(() => null);
    const results = res?.results || [];
    const ok = results.filter((r) => ["sent", "prefilled"].includes(r.state)).length;
    const bad = results.filter((r) => !["sent", "prefilled"].includes(r.state));
    status.textContent = bad.length === 0
      ? `Delivered to all ${ok}.`
      : `${ok} sent, ${bad.length} failed (${bad.map((r) => r.providerId).join(", ")}).`;
  });

  grid.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openGrid" }).catch(() => null);
  });

  close.addEventListener("click", destroy);
})();
