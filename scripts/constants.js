/**
 * PromptCast — shared constants.
 *
 * One file both the worker and the pages import. Timeouts are ceilings,
 * not floors: every wait is MutationObserver-driven and resolves the
 * moment the element mounts.
 */

// How long to wait for an input element to appear before giving up.
const FIND_TIMEOUT_MS = 8000;
// Poll step while waiting for mount.
const FIND_POLL_MS = 120;
// Post-detection settle so the editor finishes hydrating (capped).
const SETTLE_CAP_MS = 2500;
// Pause between a successful fill and the submit action.
const SUBMIT_DELAY = 400;
// Per-service overall delivery budget in grid mode.
const SERVICE_TIMEOUT_MS = 45000;
// Prompt history cap.
const MAX_HISTORY = 30;
// Storage keys.
const GRID_DATA_PREFIX = "promptcast_grid_";
const HISTORY_KEY = "promptHistory";
