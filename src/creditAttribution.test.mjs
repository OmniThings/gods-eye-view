import { readStylesheet } from './testSupport/readStylesheet.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readStylesheet(path.join(ROOT, 'style.css'));

// PolCam uses a different font and wrapping credits. The former 28px credit /
// 62px dock constants no longer represent the rendered UI. Unit tests resolve
// the real cascade here; scripts/qa-polcam-attribution.mjs measures actual boxes
// in Chromium, including expanded trays, instead of assuming those old sizes.

/** Mask bracket/paren contents so combinator splitting cannot land inside them. */
function maskGroups(selector) {
  let out = '';
  let depth = 0;
  for (const char of selector) {
    if (char === '(' || char === '[') depth += 1;
    out += depth > 0 && char === ' ' ? '_' : char;
    if (char === ')' || char === ']') depth -= 1;
  }
  return out;
}

/** Split on a delimiter that is not inside brackets or parentheses. */
function splitTopLevel(text, delimiter) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (char === delimiter && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts;
}

/** The final compound of a complex selector — the element the rule positions. */
function lastCompound(part) {
  const masked = maskGroups(part);
  let cut = -1;
  for (let i = 0; i < masked.length; i += 1) {
    if (' >+~'.includes(masked[i])) cut = i;
  }
  return part.slice(cut + 1);
}

function compareSpecificity(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** CSS specificity as [ids, classes, types]. `:where()` contributes nothing. */
function specificity(selector) {
  let ids = 0;
  let classes = 0;
  let types = 0;
  let rest = selector;
  for (;;) {
    const match = rest.match(/:(not|is|has|where|matches)\(/);
    if (!match) break;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < rest.length; i += 1) {
      if (rest[i] === '(') depth += 1;
      else if (rest[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.ok(end > 0, `unbalanced functional pseudo-class in "${selector}"`);
    if (match[1] !== 'where') {
      let best = [0, 0, 0];
      for (const argument of splitTopLevel(rest.slice(open + 1, end), ',')) {
        const inner = specificity(argument.trim());
        if (compareSpecificity(inner, best) > 0) best = inner;
      }
      ids += best[0];
      classes += best[1];
      types += best[2];
    }
    rest = rest.slice(0, match.index) + rest.slice(end + 1);
  }
  ids += (rest.match(/#[\w-]+/g) || []).length;
  classes += (rest.match(/\.[\w-]+/g) || []).length;
  classes += (rest.match(/\[[^\]]*\]/g) || []).length;
  types += (rest.match(/::[\w-]+/g) || []).length;
  classes += (rest.replace(/::[\w-]+/g, '').match(/:[\w-]+/g) || []).length;
  types += (
    rest.replace(/\[[^\]]*\]/g, '').match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) || []
  ).length;
  return [ids, classes, types];
}

/** Flatten style.css into rules carrying their raw media stack. */
function flattenRules(source) {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const mediaStack = [];
  let index = 0;
  let prelude = '';
  while (index < src.length) {
    const char = src[index];
    if (char === '{') {
      const head = prelude.replace(/\s+/g, ' ').trim();
      prelude = '';
      if (head.startsWith('@media')) {
        mediaStack.push(head.slice('@media'.length).trim());
        index += 1;
        continue;
      }
      if (head.startsWith('@')) {
        let level = 1;
        index += 1;
        while (index < src.length && level > 0) {
          if (src[index] === '{') level += 1;
          else if (src[index] === '}') level -= 1;
          index += 1;
        }
        continue;
      }
      const close = src.indexOf('}', index);
      assert.ok(close > index, `unterminated rule block for "${head}"`);
      const decls = [];
      for (const raw of src.slice(index + 1, close).split(';')) {
        const text = raw.trim();
        if (!text) continue;
        const colon = text.indexOf(':');
        if (colon < 0) continue;
        const value = text.slice(colon + 1).trim();
        decls.push({
          prop: text.slice(0, colon).trim().toLowerCase(),
          value: value.replace(/\s*!important$/i, '').trim(),
          important: /!important\s*$/i.test(value),
        });
      }
      rules.push({
        order: rules.length,
        media: [...mediaStack],
        parts: splitTopLevel(head, ',')
          .map((part) =>
            part.trim().replace(/\(\s+/g, '(').replace(/\s+\)/g, ')'),
          )
          .filter(Boolean),
        decls,
      });
      index = close + 1;
      continue;
    }
    if (char === '}') {
      mediaStack.pop();
      prelude = '';
      index += 1;
      continue;
    }
    prelude += char;
    index += 1;
  }
  return rules;
}

const RULES = flattenRules(css);

/** A media condition the model can resolve, or null. */
function parseMediaCondition(condition) {
  const match = /^\(max-width:\s*(\d+)px\)$/.exec(condition.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Whether a rule applies at `width`. Only ever asked of rules that already
 * match a modelled selector, so an unresolvable condition there is a genuine
 * hole in the model and fails rather than being skipped.
 */
function appliesAt(rule, width, label) {
  return rule.media.every((condition) => {
    const maxWidth = parseMediaCondition(condition);
    assert.ok(
      maxWidth !== null,
      `unmodelled media condition "${condition}" gates ${label}`,
    );
    return width <= maxWidth;
  });
}

/** Resolve `prop` by real cascade order: importance, then specificity, then source. */
function resolve(candidates, prop, width, label) {
  let winner = null;
  for (const rule of RULES) {
    if (!rule.parts.some((part) => candidates.includes(part))) continue;
    if (!appliesAt(rule, width, label)) continue;
    for (const part of rule.parts) {
      if (!candidates.includes(part)) continue;
      for (const decl of rule.decls) {
        if (decl.prop !== prop) continue;
        const contender = {
          decl,
          part,
          order: rule.order,
          spec: specificity(part),
        };
        if (!winner) {
          winner = contender;
          continue;
        }
        const byImportance =
          Number(contender.decl.important) - Number(winner.decl.important);
        const bySpecificity = compareSpecificity(contender.spec, winner.spec);
        if (
          byImportance > 0 ||
          (byImportance === 0 && bySpecificity > 0) ||
          (byImportance === 0 &&
            bySpecificity === 0 &&
            contender.order > winner.order)
        ) {
          winner = contender;
        }
      }
    }
  }
  assert.ok(winner, `no "${prop}" resolves for ${label} at ${width}px`);
  return winner;
}

const CREDIT = '#cesium-credits';
const POLCAM = "body[data-layout='polcam'] #cesium-credits";
const ORDINARY =
  'body:not(.ui-clean-view):not(.recording-mode) #cesium-credits';
const MINIMAL =
  "body:not(.ui-clean-view):not(.recording-mode):has(#intel-hud[data-variant='minimal'].active) #cesium-credits";
const MODES = ['', 'ui-clean-view', 'recording-mode'];
const WIDTHS = [320, 390, 560, 561, 720, 800, 801, 900, 1100, 1440];
const HIDDEN_CHROME =
  "body[data-layout='polcam']:is(.ui-clean-view, .recording-mode) #cesium-credits";
const ALPR =
  "body:has(.data-toggle-row[data-layer-id='alpr-cameras'] .data-toggle-btn.active) #cesium-credits";
const knownSelectors = new Set([
  CREDIT,
  POLCAM,
  ORDINARY,
  MINIMAL,
  ALPR,
  HIDDEN_CHROME,
]);
for (const mode of MODES.filter(Boolean)) {
  knownSelectors.add(`body.${mode} #cesium-credits`);
  knownSelectors.add(`body[data-layout='polcam'].${mode} #cesium-credits`);
}
function candidates(mode, variant) {
  return [
    CREDIT,
    POLCAM,
    ...(mode
      ? [
          `body.${mode} #cesium-credits`,
          `body[data-layout='polcam'].${mode} #cesium-credits`,
          HIDDEN_CHROME,
        ]
      : [ORDINARY, ...(variant === 'minimal' ? [MINIMAL] : [])]),
  ];
}
const ownCreditRules = RULES.flatMap((rule) =>
  rule.parts
    .filter((part) => lastCompound(part) === CREDIT)
    .map((part) => ({ rule, part })),
);

test('PolCam attribution cascade models attribute and minimal-HUD specificity', () => {
  assert.deepEqual(specificity(POLCAM), [1, 1, 1]);
  assert.deepEqual(specificity(ORDINARY), [1, 2, 1]);
  assert.ok(compareSpecificity(specificity(MINIMAL), specificity(POLCAM)) > 0);
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(index, /<body\s+data-layout="polcam"/);
});

test('every attribution own-box rule is understood, including PolCam overrides', () => {
  assert.ok(ownCreditRules.some(({ part }) => part === POLCAM));
  for (const { rule, part } of ownCreditRules) {
    assert.ok(
      knownSelectors.has(part),
      `Unmodelled attribution selector: ${part}`,
    );
    for (const condition of rule.media) {
      assert.notEqual(
        parseMediaCondition(condition),
        null,
        `Unmodelled attribution media: ${condition}`,
      );
    }
    for (const decl of rule.decls) {
      assert.ok(
        ![
          'all',
          'inset',
          'inset-block',
          'height',
          'max-height',
          'transform',
          'translate',
          'scale',
        ].includes(decl.prop),
        `Attribution geometry changed (${part}: ${decl.prop}); update the model and browser sweep`,
      );
    }
  }
});

test('PolCam placement wins over legacy offsets in every HUD and visibility mode', () => {
  for (const width of WIDTHS) {
    for (const mode of MODES) {
      for (const variant of ['tactical', 'operator', 'minimal']) {
        const selectors = candidates(mode, variant);
        const bottom = resolve(
          selectors,
          'bottom',
          width,
          `credit ${mode}/${variant}`,
        );
        assert.ok(
          bottom.part.includes("data-layout='polcam'"),
          `${width}px ${mode}/${variant} still uses legacy credit positioning: ${bottom.part}`,
        );
        assert.match(
          bottom.decl.value,
          /^\d+(?:\.\d+)?px$/,
          'PolCam placement must use its measured workspace band',
        );
        assert.ok(
          Number.parseFloat(bottom.decl.value) >= (mode ? 0 : 30),
          `${width}px ${variant}: ordinary credits intrude into the 30px status band`,
        );
        assert.equal(
          resolve(selectors, 'font-size', width, 'credit font').decl.value,
          '11px',
        );
        assert.equal(
          resolve(selectors, 'white-space', width, 'credit wrapping').decl
            .value,
          'normal',
        );
      }
    }
  }
});

test('required attribution is never hidden, clipped, or disabled to fit the workspace', () => {
  for (const { rule, part } of ownCreditRules) {
    for (const { prop, value } of rule.decls) {
      if (prop === 'display') assert.notEqual(value, 'none', part);
      if (prop === 'visibility') assert.notEqual(value, 'hidden', part);
      if (prop === 'opacity') assert.ok(Number(value) > 0, part);
      if (prop === 'overflow' || prop === 'overflow-y')
        assert.notEqual(value, 'hidden', part);
      if (prop === 'pointer-events') assert.notEqual(value, 'none', part);
    }
  }
  assert.ok(
    fs.existsSync(path.join(ROOT, 'scripts/qa-polcam-attribution.mjs')),
    'rendered clearance must be checked separately from CSS declarations',
  );
});
