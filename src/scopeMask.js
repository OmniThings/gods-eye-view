import { getKeyholeGeometry } from './celestialRing.js';

/**
 * PolCam keeps the full map viewport unobscured. The former peripheral Scope
 * canvas is retired: startup, old share links and saved scenes cannot install
 * it again. These compatibility exports retain the historical serialization
 * and geometry contracts without allocating a canvas or subscribing to frames.
 * The optional surveillance/NVG shader is a separate visual style.
 */
export const SCOPE_FEATHER_RATIO_DEFAULT = 0.11;
export const SCOPE_OUTSIDE_ALPHA = 0.94;
export const SCOPE_TERMINUS_MIN_PCT = 94;
export const SCOPE_TERMINUS_MAX_PCT = 100;
export const SCOPE_TERMINUS_ALPHA_NEAR = 1;
export const SCOPE_TERMINUS_FAR_M = 10_000_000;
export const SCOPE_TERMINUS_NEAR_M = 7_000_000;
export const SCOPE_TERMINUS_QUANTUM = 0.005;

let _featherRatio = SCOPE_FEATHER_RATIO_DEFAULT;
let _terminusOverride = null;

/** Historical geometry helpers; none of these functions draws on the map. */
export function scopeTerminusAlpha(heightM) {
  const h = Number(heightM);
  if (!Number.isFinite(h)) return SCOPE_OUTSIDE_ALPHA; // unknown height → globe-scale default
  if (h >= SCOPE_TERMINUS_FAR_M) return SCOPE_OUTSIDE_ALPHA;
  if (h <= SCOPE_TERMINUS_NEAR_M) return SCOPE_TERMINUS_ALPHA_NEAR;
  // 0 at the far edge → 1 at the near edge, eased so neither end steps visibly.
  const t =
    (SCOPE_TERMINUS_FAR_M - h) / (SCOPE_TERMINUS_FAR_M - SCOPE_TERMINUS_NEAR_M);
  const eased = t * t * (3 - 2 * t);
  return (
    SCOPE_OUTSIDE_ALPHA +
    (SCOPE_TERMINUS_ALPHA_NEAR - SCOPE_OUTSIDE_ALPHA) * eased
  );
}

export function quantizeScopeTerminusAlpha(alpha) {
  const a = Math.max(0, Math.min(1, Number(alpha) || 0));
  // Round the PRODUCT too: n * 0.005 lands on values like 0.9400000000000001,
  // which would ride straight into the rgba() string. The quantum is 3-decimal,
  // so 3 decimals is lossless here.
  return (
    Math.round(
      Math.round(a / SCOPE_TERMINUS_QUANTUM) * SCOPE_TERMINUS_QUANTUM * 1000,
    ) / 1000
  );
}

export function clampScopeTerminusPct(value) {
  // Anything that is not an actual number — null, undefined, '', 'abc', a
  // boolean — is ABSENT, not zero. (Number(null) === 0 would otherwise pin the
  // floor on every adaptive write.)
  const raw = typeof value === 'string' ? value.trim() : value;
  if (typeof raw !== 'number' && (typeof raw !== 'string' || raw === ''))
    return null;
  const pct = Number(raw);
  if (!Number.isFinite(pct)) return null;
  return Math.max(
    SCOPE_TERMINUS_MIN_PCT,
    Math.min(SCOPE_TERMINUS_MAX_PCT, Math.round(pct)),
  );
}

export function scopeMaskGeometry(width, height, featherRatio = _featherRatio) {
  const keyhole = getKeyholeGeometry(width, height);
  if (!(keyhole.radius > 0)) return null;
  const feather = Math.max(0, Math.min(1, Number(featherRatio) || 0));
  // Feather straddles the keyhole edge so the visible radius stays anchored
  // to the shared geometry every keyhole consumer (labels, cards) fades on.
  const half = keyhole.radius * feather * 0.5;
  return {
    centerX: keyhole.centerX,
    centerY: keyhole.centerY,
    innerR: Math.max(0, keyhole.radius - half),
    outerR: keyhole.radius + half,
    maxR: Math.hypot(
      Math.max(keyhole.centerX, width - keyhole.centerX),
      Math.max(keyhole.centerY, height - keyhole.centerY),
    ),
  };
}

export function scopeMaskDevicePixelRatio(
  ratio = typeof window !== 'undefined' ? window.devicePixelRatio : 1,
) {
  return Math.min(2, Number(ratio) || 1);
}

/** Retained lifecycle entry points intentionally allocate no rendering work. */
export function installScopeMask() {}
export function destroyScopeMask() {}

/** Ignore even explicit enable requests from older snapshots and integrations. */
export function setScopeMaskEnabled() {}
export function isScopeMaskEnabled() {
  return false;
}

export function updateScopeTerminusForHeight() {
  return false;
}
export function getScopeTerminusAlpha() {
  return 0;
}
export function getScopeTerminusRepaintCount() {
  return 0;
}

/** Retain legacy values for round trips, without changing visibility. */
export function setScopeMaskFeather(ratio) {
  _featherRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
}
export function getScopeMaskFeather() {
  return _featherRatio;
}
export function setScopeTerminusOverride(alpha) {
  _terminusOverride =
    alpha == null || !Number.isFinite(Number(alpha))
      ? null
      : Math.max(SCOPE_OUTSIDE_ALPHA, Math.min(1, Number(alpha)));
}
export function getScopeTerminusOverride() {
  return _terminusOverride;
}

/** Test seam for legacy serialized settings. */
export function _resetScopeMaskForTest() {
  _featherRatio = SCOPE_FEATHER_RATIO_DEFAULT;
  _terminusOverride = null;
}
