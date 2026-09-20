/**
 * Dismisses common cookie/consent banners inside grid frames.
 * Runs in ISOLATED world on demand; purely cosmetic, best-effort.
 */
(function () {
  const PATTERNS = [
    '[id*="cookie" i] [aria-label*="accept" i]',
    '[id*="consent" i] button',
    '[class*="cookie" i] button[class*="accept" i]',
    'button[id*="accept-cookie" i]',
  ];
  for (const sel of PATTERNS) {
    try {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); break; }
    } catch { /* keep trying */ }
  }
})();
