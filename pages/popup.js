/**
 * PromptCast — popup composer.
 *
 * One prompt box, provider toggles, send. Renders the worker's
 * per-provider delivery records so failures are visible here too,
 * not just in the grid.
 */
const KNOWN = ["chatgpt", "claude", "gemini", "copilot", "deepseek", "perplexity", "grok"];

const promptInput = document.getElementById("promptInput");
const providerList = document.getElementById("providerList");
const sendStatus = document.getElementById("sendStatus");

init();

async function init() {
  const { settings = {} } = await chrome.storage.sync.get("settings");
  const enabled = new Set(settings.enabledProviders || KNOWN);
  const custom = settings.customProviders || [];

  for (const id of [...KNOWN, ...custom.map((c) => c.id)]) {
    const name = custom.find((c) => c.id === id)?.name
      || (id[0].toUpperCase() + id.slice(1));
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = enabled.has(id);
    box.dataset.provider = id;
    label.append(box, ` ${name}`);
    providerList.appendChild(label);
  }

  const { pendingPrompt } = await chrome.storage.session.get("pendingPrompt");
  if (pendingPrompt) {
    promptInput.value = pendingPrompt;
    await chrome.storage.session.remove("pendingPrompt");
  }

  renderRecents(settings);
  document.getElementById("promptForm").addEventListener("submit", onSend);
  document.getElementById("gridBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/grid.html") });
  });
}

async function onSend(e) {
  e.preventDefault();
  const query = promptInput.value.trim();
  if (!query) return;
  const ids = [...providerList.querySelectorAll("input:checked")].map((b) => b.dataset.provider);
  if (ids.length === 0) {
    sendStatus.textContent = "Pick at least one provider.";
    return;
  }
  sendStatus.textContent = `Sending to ${ids.length}…`;
  const res = await chrome.runtime.sendMessage({
    type: "multicast",
    query,
    opts: { providerIds: ids },
  }).catch(() => null);
  const results = res?.results || [];
  const ok = results.filter((r) => ["sent", "prefilled"].includes(r.state)).length;
  const bad = results.filter((r) => !["sent", "prefilled"].includes(r.state));
  sendStatus.textContent = bad.length === 0
    ? `Delivered to all ${ok}.`
    : `${ok} sent, ${bad.length} failed: ${bad.map((r) => r.providerId).join(", ")}. Open the grid to retry.`;
  saveRecent(query);
}

async function renderRecents(settings) {
  if (settings.showRecents === false) return;
  const { promptHistory = [] } = await chrome.storage.local.get("promptHistory");
  const list = document.getElementById("recentList");
  list.innerHTML = "";
  for (const h of promptHistory.slice(0, 8)) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = typeof h === "string" ? h : h.text;
    btn.addEventListener("click", () => { promptInput.value = btn.textContent; });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function saveRecent(query) {
  const { settings = {} } = await chrome.storage.sync.get("settings");
  if (settings.enableHistory === false) return;
  const { promptHistory = [] } = await chrome.storage.local.get("promptHistory");
  const next = [{ text: query, at: Date.now() },
    ...(Array.isArray(promptHistory) ? promptHistory : [])]
    .filter((h, i, a) => a.findIndex((x) => (x.text || x) === (h.text || h)) === i)
    .slice(0, settings.historyLimit || 30);
  await chrome.storage.local.set({ promptHistory: next });
}
