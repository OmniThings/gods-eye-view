import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeMaskGeometry,
  scopeMaskDevicePixelRatio,
  scopeTerminusAlpha,
  quantizeScopeTerminusAlpha,
  updateScopeTerminusForHeight,
  setScopeTerminusOverride,
  getScopeTerminusOverride,
  getScopeTerminusAlpha,
  getScopeTerminusRepaintCount,
  clampScopeTerminusPct,
  installScopeMask,
  destroyScopeMask,
  setScopeMaskEnabled,
  isScopeMaskEnabled,
  setScopeMaskFeather,
  SCOPE_TERMINUS_MIN_PCT,
  SCOPE_TERMINUS_MAX_PCT,
  SCOPE_FEATHER_RATIO_DEFAULT,
  SCOPE_OUTSIDE_ALPHA,
  SCOPE_TERMINUS_ALPHA_NEAR,
  SCOPE_TERMINUS_FAR_M,
  SCOPE_TERMINUS_NEAR_M,
  SCOPE_TERMINUS_QUANTUM,
  _resetScopeMaskForTest,
} from './scopeMask.js';
import { KEYHOLE_OUTER_RADIUS } from './celestialRing.js';

beforeEach(() => _resetScopeMaskForTest());

test('geometry anchors the visible edge to the shared keyhole radius', () => {
  const geo = scopeMaskGeometry(1440, 860, 0.4);
  const keyholeR = 860 * 0.5 * KEYHOLE_OUTER_RADIUS;
  assert.ok(geo);
  assert.equal(geo.centerX, 720);
  assert.equal(geo.centerY, 430);
  // Feather straddles the keyhole edge: inner+outer average = keyhole radius.
  assert.ok(Math.abs((geo.innerR + geo.outerR) / 2 - keyholeR) < 1e-9);
  assert.ok(Math.abs((geo.outerR - geo.innerR) - keyholeR * 0.4) < 1e-9);
});

test('zero feather produces a hard edge exactly at the keyhole radius', () => {
  const geo = scopeMaskGeometry(1000, 800, 0);
  const keyholeR = 800 * 0.5 * KEYHOLE_OUTER_RADIUS;
  assert.equal(geo.innerR, keyholeR);
  assert.equal(geo.outerR, keyholeR);
});

test('feather ratio is clamped to [0,1] and bad input falls back to 0', () => {
  const wide = scopeMaskGeometry(1000, 800, 7);
  const one = scopeMaskGeometry(1000, 800, 1);
  assert.equal(wide.innerR, one.innerR);
  assert.equal(wide.outerR, one.outerR);
  const nan = scopeMaskGeometry(1000, 800, Number.NaN);
  const zero = scopeMaskGeometry(1000, 800, 0);
  assert.equal(nan.innerR, zero.innerR);
});

test('degenerate viewport yields null instead of a broken gradient', () => {
  assert.equal(scopeMaskGeometry(0, 0), null);
  assert.equal(scopeMaskGeometry(-5, 100), null);
});

test('an omitted feather argument uses the module default, whatever it is', () => {
  // The assertion here is the WIRING — that calling scopeMaskGeometry with no
  // ratio really consults SCOPE_FEATHER_RATIO_DEFAULT rather than some second,
  // private constant. Comparing the omitted-argument geometry against an
  // explicitly-passed default keeps that alive at ANY default value. The old
  // form (band width === keyholeR × default) went VACUOUSLY true the moment the
  // default moved to 0 on 2026-08-22 — both sides collapse to zero — so it is
  // written this way deliberately.
  const omitted = scopeMaskGeometry(1200, 900);
  const explicit = scopeMaskGeometry(1200, 900, SCOPE_FEATHER_RATIO_DEFAULT);
  assert.equal(omitted.innerR, explicit.innerR);
  assert.equal(omitted.outerR, explicit.outerR);
  // And it is not simply ignoring the argument: a different ratio must differ,
  // and must still derive its band from the keyhole radius.
  const wider = scopeMaskGeometry(1200, 900, SCOPE_FEATHER_RATIO_DEFAULT + 0.4);
  assert.notEqual(wider.outerR - wider.innerR, omitted.outerR - omitted.innerR);
  const keyholeR = 900 * 0.5 * KEYHOLE_OUTER_RADIUS;
  assert.ok(Math.abs((wider.outerR - wider.innerR)
    - keyholeR * (SCOPE_FEATHER_RATIO_DEFAULT + 0.4)) < 1e-9);
  // The default's VALUE (hidden feather, owner directive 2026-08-22) is pinned
  // with the rest of the first-run batch in reasonableDefaults.test.mjs.
});

test('backing-store scale is clamped to 2x and survives junk input', () => {
  assert.equal(scopeMaskDevicePixelRatio(1), 1);
  assert.equal(scopeMaskDevicePixelRatio(2), 2);
  assert.equal(scopeMaskDevicePixelRatio(3), 2); // clamp — a 3x panel still draws at 2x
  assert.equal(scopeMaskDevicePixelRatio(0), 1);
  assert.equal(scopeMaskDevicePixelRatio(Number.NaN), 1);
});

test('the terminus band is the owner-approved 10 Mm → 7 Mm fade', () => {
  assert.equal(SCOPE_TERMINUS_FAR_M, 10_000_000, 'the relaxed corners start above 10 Mm');
  assert.equal(SCOPE_TERMINUS_NEAR_M, 7_000_000, 'and are gone by 7 Mm');
  assert.equal(scopeTerminusAlpha(10_500_000), SCOPE_OUTSIDE_ALPHA, 'full-globe view keeps its stars');
  assert.equal(scopeTerminusAlpha(6_900_000), SCOPE_TERMINUS_ALPHA_NEAR, 'below the band: solid black');
  assert.equal(scopeTerminusAlpha(400_000), SCOPE_TERMINUS_ALPHA_NEAR, 'orbital view: solid black');
  assert.equal(scopeTerminusAlpha(1_500), SCOPE_TERMINUS_ALPHA_NEAR, 'city view: solid black');
  // Quick, not gradual: a fifth of the way down the band it is already past halfway.
  const fifth = SCOPE_TERMINUS_FAR_M - (SCOPE_TERMINUS_FAR_M - SCOPE_TERMINUS_NEAR_M) * 0.5;
  assert.ok(scopeTerminusAlpha(fifth) > SCOPE_OUTSIDE_ALPHA + 0.02,
    'the fade must be well underway by mid-band');
});

test('terminus ramp: translucent at globe scale, full black up close', () => {
  assert.equal(scopeTerminusAlpha(SCOPE_TERMINUS_FAR_M), SCOPE_OUTSIDE_ALPHA);
  assert.equal(scopeTerminusAlpha(SCOPE_TERMINUS_FAR_M + 1_000_000), SCOPE_OUTSIDE_ALPHA);
  assert.equal(scopeTerminusAlpha(SCOPE_TERMINUS_NEAR_M), SCOPE_TERMINUS_ALPHA_NEAR);
  assert.equal(scopeTerminusAlpha(0), SCOPE_TERMINUS_ALPHA_NEAR);
});

test('terminus ramp is monotonic, bounded, and eased at both ends', () => {
  const mid = (SCOPE_TERMINUS_FAR_M + SCOPE_TERMINUS_NEAR_M) / 2;
  assert.ok(Math.abs(scopeTerminusAlpha(mid) - (SCOPE_OUTSIDE_ALPHA + 0.06 / 2)) < 1e-9,
    'smoothstep is symmetric — the midpoint sits halfway');

  let previous = -Infinity;
  for (let h = 15_000_000; h >= 0; h -= 100_000) {
    const alpha = scopeTerminusAlpha(h);
    assert.ok(alpha >= previous, `alpha must never decrease while descending (h=${h})`);
    assert.ok(alpha >= SCOPE_OUTSIDE_ALPHA && alpha <= 1, `alpha out of range at h=${h}`);
    previous = alpha;
  }

  // Eased, not linear: near each end the slope is gentler than the midpoint's.
  const step = 100_000;
  const nearEnd = scopeTerminusAlpha(SCOPE_TERMINUS_NEAR_M + step) - scopeTerminusAlpha(SCOPE_TERMINUS_NEAR_M);
  const middle = scopeTerminusAlpha(mid) - scopeTerminusAlpha(mid + step);
  assert.ok(Math.abs(nearEnd) < Math.abs(middle), 'the ramp must ease into the near clamp');
});

test('terminus ramp survives junk heights without breaking the paint', () => {
  assert.equal(scopeTerminusAlpha(Number.NaN), SCOPE_OUTSIDE_ALPHA);
  assert.equal(scopeTerminusAlpha(undefined), SCOPE_OUTSIDE_ALPHA);
  assert.equal(scopeTerminusAlpha(Number.POSITIVE_INFINITY), SCOPE_OUTSIDE_ALPHA);
  assert.equal(scopeTerminusAlpha(-1000), SCOPE_TERMINUS_ALPHA_NEAR, 'below the datum is still "close"');
});

test('quantization snaps to the repaint grid', () => {
  assert.equal(quantizeScopeTerminusAlpha(0.9412), 0.94);
  assert.equal(quantizeScopeTerminusAlpha(0.9436), 0.945);
  assert.equal(quantizeScopeTerminusAlpha(1), 1);
  assert.equal(quantizeScopeTerminusAlpha(5), 1, 'clamped');
  assert.equal(quantizeScopeTerminusAlpha(Number.NaN), 0);
});

test('terminus percents clamp into the supported band; junk is absent, not zero', () => {
  assert.equal(SCOPE_TERMINUS_MIN_PCT, 94);
  assert.equal(SCOPE_TERMINUS_MAX_PCT, 100);
  assert.equal(clampScopeTerminusPct(97), 97);
  assert.equal(clampScopeTerminusPct(96.6), 97);
  assert.equal(clampScopeTerminusPct(0), 94, 'a sub-band value is floored, never honoured');
  assert.equal(clampScopeTerminusPct(93), 94);
  assert.equal(clampScopeTerminusPct(-100), 94);
  assert.equal(clampScopeTerminusPct(1000), 100);
  assert.equal(clampScopeTerminusPct('98'), 98, 'hash values arrive as strings');
  assert.equal(clampScopeTerminusPct(null), null, 'absent means adaptive, not 0');
  assert.equal(clampScopeTerminusPct(undefined), null);
  assert.equal(clampScopeTerminusPct(''), null);
  assert.equal(clampScopeTerminusPct('abc'), null);
  assert.equal(clampScopeTerminusPct(Number.NaN), null);
  assert.equal(clampScopeTerminusPct(true), null);
});



test('PolCam startup and old enable requests allocate no mask or observers', () => {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver,
  };
  const forbidden = () => assert.fail('retired scope must not allocate or observe');
  const viewer = new Proxy({}, { get: forbidden });
  globalThis.document = { createElement: forbidden };
  globalThis.window = { matchMedia: forbidden };
  globalThis.ResizeObserver = class { constructor() { forbidden(); } };
  try {
    assert.equal(isScopeMaskEnabled(), false, 'fresh startup is unobscured');
    for (let i = 0; i < 3; i += 1) {
      installScopeMask(viewer);
      setScopeMaskEnabled(true);
      setScopeMaskFeather(i / 2);
      setScopeTerminusOverride(1);
      assert.equal(updateScopeTerminusForHeight(i * 10_000_000), false);
      assert.equal(isScopeMaskEnabled(), false, 'legacy enable cannot restore the mask');
      assert.equal(getScopeTerminusAlpha(), 0, 'the actual viewport stays transparent');
      assert.equal(getScopeTerminusRepaintCount(), 0);
      destroyScopeMask();
    }
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('legacy tuning values remain serializable without drawing', () => {
  setScopeTerminusOverride(0);
  assert.equal(getScopeTerminusOverride(), SCOPE_OUTSIDE_ALPHA);
  setScopeTerminusOverride(5);
  assert.equal(getScopeTerminusOverride(), 1);
  setScopeTerminusOverride(null);
  assert.equal(getScopeTerminusOverride(), null);
  assert.equal(getScopeTerminusAlpha(), 0);
  assert.equal(getScopeTerminusRepaintCount(), 0);
});
