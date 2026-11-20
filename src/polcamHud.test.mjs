import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

// Match the existing HUD datum test's bridge for mgrs (CommonJS named exports
// are resolved by Vite in the browser, but not by Node's ESM loader).
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mgrs')
      return { url: 'polcam-hud-test:mgrs', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'polcam-hud-test:mgrs')
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export function forward() { return "32UNE00000000"; }',
      };
    return next(url, context);
  },
});
const { IntelHUD } = await import('./hud.js');
hook.deregister();

test('PolCam HUD preserves live consumer IDs without fictional classification or recording claims', () => {
  const originalDocument = globalThis.document;
  const host = { innerHTML: '', dataset: {} };
  globalThis.document = {
    getElementById: (id) => (id === 'intel-hud' ? host : null),
  };
  try {
    IntelHUD.prototype._buildDOM.call({
      _variant: 'minimal',
      _formatUTC: () => '2026-11-20 12:00:00Z',
    });
    const ids = [...host.innerHTML.matchAll(/\bid="([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.equal(ids.length, new Set(ids).size, 'telemetry IDs must be unique');
    for (const id of [
      'hud-mode',
      'hud-summary',
      'hud-latlon',
      'hud-mgrs',
      'hud-alt',
      'hud-ona',
      'hud-ais-vessel',
      'hud-timestamp',
    ]) {
      assert.ok(
        ids.includes(id),
        `${id} is updated by an existing HUD or vessel consumer`,
      );
    }
    assert.equal(host.dataset.variant, 'minimal');
    assert.match(host.innerHTML, /2026-11-20 12:00:00Z/);
    assert.doesNotMatch(
      host.innerHTML,
      /TOP SECRET|NOFORN|KH11-|ORB:|PASS:|\bREC\b|hud-rec-dot/,
    );
  } finally {
    globalThis.document = originalDocument;
  }
});
