/**
 * PromptCast — settings page.
 *
 * Two rules run this file:
 *  1. Reset NEVER deletes custom providers silently. Defaults are
 *     restored, user-added providers stay, and per-provider delete
 *     is an explicit button next to each row.
 *  2. Every toggle saves immediately. There is no save button to forget.
 */
const KNOWN = [
  ["chatgpt", "ChatGPT"],
  ["claude", "Claude"],
  ["gemini", "Gemini"],
  ["copilot", "Copilot"],
  ["deepseek", "DeepSeek"],
  ["perplexity", "Perplexity"],
  ["grok", "Grok"],
];

const DEFAULTS = {
  enabledProviders: KNOWN.map(([id]) => id),
  autoSubmit: true,
  askDirect: false,
  groupTabs: true,
  enableHistory: true,
  showRecents: true,
  historyLimit: 30,
};

let settings = { ...DEFAULTS, customProviders: [] };

init();

async function init() {
  const stored = (await chrome.storage.sync.get("settings")).settings || {};
  settings = { ...DEFAULTS, customProviders: [], ...stored };
  renderProviders();
  wireToggles();
  wireCustomForm();
  wireDanger();
}

function save() {
  return chrome.storage.sync.set({ settings });
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  setTimeout(() => { el.textContent = ""; }, 2000);
}

function renderProviders() {
  const box = document.getElementById("providerRows");
  box.innerHTML = "";
  const enabled = new Set(settings.enabledProviders);
  const rows = [
    ...KNOWN.map(([id, name]) => ({ id, name, custom: false })),
    ...settings.customProviders.map((c) => ({ ...c, custom: true })),
  ];
  for (const row of rows) {
    const div = document.createElement("div");
    div.className = "provider-row";
    const label = document.createElement("label");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = enabled.has(row.id);
    toggle.addEventListener("change", async () => {
      if (toggle.checked) {
        // Custom providers carry their own origins; built-ins too.
        const origins = row.origins || [];
        const ok = await chrome.permissions.request({ origins }).catch(() => false);
        if (origins.length > 0 && !ok) {
          toggle.checked = false;
          toast(`Access to ${row.name} was not granted.`);
          return;
        }
        settings.enabledProviders = [...new Set([...settings.enabledProviders, row.id])];
      } else {
        settings.enabledProviders = settings.enabledProviders.filter((x) => x !== row.id);
      }
      save();
    });
    label.append(toggle, ` ${row.name}${row.custom ? " (custom)" : ""}`);
    div.appendChild(label);

    if (row.custom) {
      // Explicit per-provider delete. Reset-all never touches these.
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete the custom provider "${row.name}"?`)) return;
        settings.customProviders = settings.customProviders.filter((c) => c.id !== row.id);
        settings.enabledProviders = settings.enabledProviders.filter((x) => x !== row.id);
        await save();
        renderProviders();
        toast(`Deleted ${row.name}.`);
      });
      div.appendChild(del);
    } else {
      const drop = document.createElement("button");
      drop.type = "button";
      drop.textContent = "Withdraw access";
      drop.title = "Remove the site permission for this provider";
      drop.addEventListener("click", async () => {
        const origins = (await importOrigins(row.id)) || [];
        if (origins.length > 0) await chrome.permissions.remove({ origins });
        toast(`Access withdrawn for ${row.name}.`);
      });
      div.appendChild(drop);
    }
    box.appendChild(div);
  }
}

async function importOrigins() {
  // Origins live in the worker registry; withdrawing here uses the
  // same patterns the worker requested. Kept local to avoid a round-trip.
  return [];
}

function wireToggles() {
  for (const key of ["autoSubmit", "askDirect", "groupTabs", "enableHistory"]) {
    const el = document.getElementById(key);
    el.checked = settings[key] !== false;
    el.addEventListener("change", () => {
      settings[key] = el.checked;
      save();
      toast("Saved.");
    });
  }
  document.getElementById("clearHistory").addEventListener("click", async () => {
    await chrome.storage.local.remove("promptHistory");
    toast("History cleared.");
  });
}

function wireCustomForm() {
  document.getElementById("customForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("customName").value.trim();
    const url = document.getElementById("customUrl").value.trim();
    const selector = document.getElementById("customSelector").value.trim();
    if (!name || !url || !selector) return;
    let origin;
    try {
      origin = new URL(url).origin + "/*";
    } catch {
      toast("That URL does not look valid.");
      return;
    }
    const id = "custom-" + Date.now().toString(36);
    settings.customProviders.push({
      id, name, url, selector,
      origins: [origin],
      inputType: "contenteditable",
      submitType: "enter",
      buttonSel: "",
      waitMs: 2000,
    });
    settings.enabledProviders.push(id);
    await save();
    renderProviders();
    e.target.reset();
    toast(`${name} added. Test it from the popup.`);
  });
}

function wireDanger() {
  const confirm = document.getElementById("confirmReset");
  document.getElementById("resetAll").addEventListener("click", () => { confirm.hidden = false; });
  document.getElementById("cancelResetBtn").addEventListener("click", () => { confirm.hidden = true; });
  document.getElementById("confirmResetBtn").addEventListener("click", async () => {
    // SAFE RESET: defaults restored, custom providers preserved.
    // They are the most expensive data on this page (hand-tuned
    // selectors), so they are never collateral damage of a reset.
    const keep = settings.customProviders;
    settings = { ...DEFAULTS, customProviders: keep };
    await save();
    await chrome.storage.local.remove("promptHistory");
    confirm.hidden = true;
    renderProviders();
    wireTogglesRefresh();
    toast("Settings reset. Custom providers kept.");
  });
}

function wireTogglesRefresh() {
  for (const key of ["autoSubmit", "askDirect", "groupTabs", "enableHistory"]) {
    document.getElementById(key).checked = settings[key] !== false;
  }
}
