/**
 * PromptCast — origin permission helper.
 *
 * The extension installs with access to zero websites. Each provider's
 * `origins` are requested the first time that provider is switched on,
 * and can be withdrawn from Settings at any time. Adding a provider
 * never widens the install prompt.
 */

async function ensureOrigins(origins) {
  if (!origins || origins.length === 0) return true;
  const granted = await chrome.permissions.contains({ origins });
  if (granted) return true;
  return chrome.permissions.request({ origins });
}

async function dropOrigins(origins) {
  if (!origins || origins.length === 0) return true;
  return chrome.permissions.remove({ origins });
}

async function hasOrigins(origins) {
  if (!origins || origins.length === 0) return true;
  return chrome.permissions.contains({ origins });
}
