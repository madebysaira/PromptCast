/**
 * ============================================================
 *  PromptCast — Grid View
 * ============================================================
 *
 *  All enabled providers side by side in one tab. Two properties
 *  define this implementation:
 *
 *  1. PARALLEL injection. Each cell's prompt is delivered the
 *     moment its own frame loads — never after the slowest one.
 *  2. A FAILURE SURFACE. Every cell renders its delivery record:
 *     sending, sent, prefilled, or a human error with a retry
 *     button. A prompt that reaches two of seven panes must look
 *     different from one that reached all seven.
 * ============================================================
 */

const gridContainer = document.getElementById("gridContainer");
const gridQueryForm = document.getElementById("gridQueryForm");
const gridQueryInput = document.getElementById("gridQueryInput");
const gridStatus = document.getElementById("gridStatus");
const cellTemplate = document.getElementById("cellTemplate");

let cells = []; // [{ provider, el, iframe, errorBox, stateEl, delivered }]
let lastQuery = "";
let sendConfig = { autoSubmit: true };

init().catch((e) => {
  console.warn("[PromptCast] grid init without extension APIs:", e?.message || e);
});

async function init() {
  if (!globalThis.chrome?.storage) throw new Error("no extension APIs");
  const { settings = {} } = await chrome.storage.sync.get("settings");
  const enabled = settings.enabledProviders || [];
  const custom = settings.customProviders || [];
  sendConfig.autoSubmit = settings.autoSubmit !== false;

  // Grid rules on ONLY while this tab lives (scoped, session-only).
  const [selfTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (selfTab?.id) {
    await chrome.runtime.sendMessage({ type: "gridRulesOn", tabId: selfTab.id }).catch(() => null);
  }
  window.addEventListener("beforeunload", () => {
    chrome.runtime.sendMessage({ type: "gridRulesOff" }).catch(() => null);
  });

  const providers = [...enabled.map(idFromRegistry), ...custom].filter(Boolean);
  for (const provider of providers) {
    addCell(provider);
  }

  const { pendingPrompt } = await chrome.storage.session.get("pendingPrompt");
  if (pendingPrompt) {
    gridQueryInput.value = pendingPrompt;
    await chrome.storage.session.remove("pendingPrompt");
  }
  gridQueryForm.addEventListener("submit", onSend);
}

// Registry copy (ids + default URLs) so the grid builds without
// asking the worker. Delivery itself always goes via the worker.
function idFromRegistry(id) {
  const known = {
    chatgpt: "https://chatgpt.com/",
    claude: "https://claude.ai/new",
    gemini: "https://gemini.google.com/app",
    copilot: "https://copilot.microsoft.com/",
    deepseek: "https://chat.deepseek.com/",
    perplexity: "https://www.perplexity.ai/",
    grok: "https://grok.com/",
  };
  if (!known[id]) return null;
  return { id, name: id[0].toUpperCase() + id.slice(1), url: known[id] };
}

function addCell(provider) {
  const frag = cellTemplate.content.cloneNode(true);
  const el = frag.querySelector(".cell");
  el.querySelector(".cell-name").textContent = provider.name;
  const stateEl = el.querySelector(".cell-state");
  const iframe = el.querySelector("iframe");
  const errorBox = el.querySelector(".cell-error");
  iframe.title = provider.name;
  iframe.src = provider.url;
  el.querySelector(".cell-close").addEventListener("click", () => {
    el.remove();
    cells = cells.filter((c) => c.el !== el);
    layout();
  });
  const cell = { provider, el, iframe, errorBox, stateEl, delivered: false, loaded: false };
  iframe.addEventListener("load", () => {
    cell.loaded = true;
    // PARALLEL: this cell's prompt goes out the moment ITS frame
    // loads — no barrier waiting for slower providers.
    if (lastQuery && !cell.delivered) deliverToCell(cell, lastQuery);
  });
  cells.push(cell);
  gridContainer.appendChild(frag);
  layout();
}

async function onSend(e) {
  e.preventDefault();
  const query = gridQueryInput.value.trim();
  if (!query) return;
  lastQuery = query;
  gridStatus.textContent = `Sending to ${cells.length} providers…`;
  // Deliver to already-loaded cells now; the rest fire on their own
  // load event. Either way every cell ends with a rendered record.
  await Promise.all(cells.map((cell) => {
    cell.delivered = false;
    setCellState(cell, "sending", "Sending…");
    if (cell.loaded) return deliverToCell(cell, query);
    return Promise.resolve();
  }));
  updateSummary();
}

// One cell, one delivery, one rendered record. Rejects never escape:
// a failed delivery is a cell state, not a console error.
async function deliverToCell(cell, query) {
  cell.delivered = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "multicast",
      query,
      opts: { autoSubmit: sendConfig.autoSubmit, providerIds: [cell.provider.id], groupTabs: false },
    });
    const record = res?.results?.[0];
    if (!record) throw new Error("Empty delivery record");
    renderRecord(cell, record);
  } catch (err) {
    renderRecord(cell, {
      providerId: cell.provider.id,
      state: "timed-out",
      detail: String(err?.message || err),
    });
  }
  updateSummary();
}

function renderRecord(cell, record) {
  const { state, detail } = record;
  if (state === "sent" || state === "prefilled") {
    setCellState(cell, state, state === "sent" ? "Sent" : "Ready in box");
    cell.errorBox.hidden = true;
    return;
  }
  // Failure surface: state chip + human copy + retry.
  setCellState(cell, "failed", labelFor(state));
  cell.errorBox.hidden = false;
  cell.errorBox.innerHTML = "";
  const p = document.createElement("p");
  p.textContent = detail || labelFor(state);
  const retry = document.createElement("button");
  retry.textContent = "Retry";
  retry.addEventListener("click", () => {
    cell.delivered = false;
    setCellState(cell, "sending", "Sending…");
    deliverToCell(cell, lastQuery);
  });
  cell.errorBox.append(p, retry);
}

function labelFor(state) {
  return {
    "no-permission": "Needs access",
    "input-missing": "Box not found",
    "fill-unverified": "Not sent",
    "timed-out": "Timed out",
  }[state] || state;
}

function setCellState(cell, state, text) {
  cell.stateEl.textContent = text;
  cell.stateEl.dataset.state = state;
  cell.el.dataset.state = state;
}

function updateSummary() {
  const ok = cells.filter((c) => ["sent", "prefilled"].includes(c.stateEl.dataset.state)).length;
  const bad = cells.filter((c) => c.stateEl.dataset.state === "failed").length;
  const waiting = cells.length - ok - bad;
  gridStatus.textContent = waiting > 0
    ? `Sending… ${ok} done${bad ? `, ${bad} failed` : ""}`
    : `${ok} of ${cells.length} delivered${bad ? `, ${bad} failed` : ""}`;
}

// ── Minimal tile layout (equal fractions) ────────────────────
function layout() {
  const n = cells.length || 1;
  const cols = Math.ceil(Math.sqrt(n));
  gridContainer.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}
