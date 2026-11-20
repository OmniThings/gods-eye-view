import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutPolcamPanelRail } from './polcamPanelRail.js';

function node({ id = '', classes = [], styles = {}, attributes = {} } = {}) {
  const classNames = new Set(classes);
  const properties = new Map(Object.entries(styles));
  const attrs = new Map(Object.entries(attributes));
  const writes = [];
  return {
    id,
    writes,
    children: [],
    dataset: {},
    scrollTop: 125,
    classList: {
      contains: (name) => classNames.has(name),
      remove(...names) {
        writes.push(['class', ...names]);
        names.forEach((name) => classNames.delete(name));
      },
    },
    style: {
      getPropertyValue: (name) => properties.get(name) || '',
      removeProperty(name) {
        writes.push(['style', name]);
        properties.delete(name);
      },
    },
    hasAttribute: (name) => attrs.has(name),
    getAttribute: (name) => attrs.get(name),
    removeAttribute(name) {
      writes.push(['attribute', name]);
      attrs.delete(name);
    },
    querySelectorAll(selector) {
      assert.equal(selector, ':scope > [data-panel-id]');
      return this.children;
    },
  };
}

test('PolCam restores presentation collapse while preserving explicit panel choices and scroll', () => {
  const stack = node({ classes: ['layout-focus', 'layout-exclusive'] });
  const explicit = node({
    id: 'data-panel',
    classes: ['collapsed'],
    attributes: { 'aria-hidden': 'true' },
  });
  const automatic = node({
    id: 'scene-panel',
    classes: ['collapsed', 'layout-auto-collapsed'],
    attributes: { 'aria-hidden': 'true' },
  });
  const expanded = node({ id: 'cctv-panel' });
  stack.children = [explicit, automatic, expanded];
  const restored = [];

  layoutPolcamPanelRail({
    stack,
    onRestore: (panel) => restored.push(panel.id),
  });

  assert.equal(explicit.classList.contains('collapsed'), true);
  assert.equal(automatic.classList.contains('collapsed'), false);
  assert.equal(automatic.classList.contains('layout-auto-collapsed'), false);
  assert.equal(expanded.classList.contains('collapsed'), false);
  assert.deepEqual(restored, ['scene-panel']);
  assert.equal(stack.classList.contains('layout-focus'), false);
  assert.equal(stack.classList.contains('layout-exclusive'), false);
  assert.equal(stack.dataset.layoutMode, 'polcam');
  for (const panel of stack.children) {
    assert.equal(panel.hasAttribute('aria-hidden'), false);
    assert.equal(
      panel.scrollTop,
      125,
      'layout must not reset operator scrolling',
    );
  }
});

test('PolCam releases both rail allocations and remains mutation-free on subsequent passes', () => {
  const stack = node({
    classes: ['layout-tail'],
    styles: {
      '--left-stack-safe-top': '26vh',
      '--left-stack-safe-bottom': '4vh',
      '--left-stack-centered-height': '300px',
      '--right-stack-safe-top': '210px',
      '--right-stack-max-height': '450px',
      '--custom-theme-property': '#fff',
    },
  });
  const panel = node({
    styles: {
      '--left-panel-allocated-height': '150px',
      '--right-panel-allocated-height': '150px',
    },
  });
  stack.children = [panel];
  layoutPolcamPanelRail({ stack });
  assert.equal(stack.classList.contains('layout-tail'), false);
  for (const name of [
    '--left-stack-safe-top',
    '--left-stack-safe-bottom',
    '--left-stack-centered-height',
    '--right-stack-safe-top',
    '--right-stack-max-height',
  ])
    assert.equal(stack.style.getPropertyValue(name), '');
  assert.equal(stack.style.getPropertyValue('--custom-theme-property'), '#fff');
  assert.equal(
    panel.style.getPropertyValue('--left-panel-allocated-height'),
    '',
  );
  assert.equal(
    panel.style.getPropertyValue('--right-panel-allocated-height'),
    '',
  );

  stack.writes.length = 0;
  panel.writes.length = 0;
  layoutPolcamPanelRail({ stack });
  assert.deepEqual(stack.writes, [], 'avoid observer feedback loops');
  assert.deepEqual(panel.writes, [], 'parked overlays must remain idle');
});

test('PolCam tolerates absent optional rails', () => {
  assert.doesNotThrow(() => layoutPolcamPanelRail({ stack: null }));
});
