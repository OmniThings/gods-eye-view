/**
 * Release adaptive rail geometry for the fixed PolCam workspace. CSS owns the
 * responsive lane bounds and panel scrollers; disclosure owns user preferences.
 * Keep every panel header available, including after a restored tactical HUD
 * auto-collapsed or hid a sibling in the former floating layout.
 */
export function layoutPolcamPanelRail({ stack, onRestore = () => {} }) {
  if (!stack) return;

  // Avoid no-op class/style mutations: observers schedule another layout pass
  // and world overlays treat chrome changes as a reason to remeasure labels.
  for (const name of ['layout-focus', 'layout-tail', 'layout-exclusive']) {
    if (stack.classList.contains(name)) stack.classList.remove(name);
  }
  for (const name of [
    '--left-stack-safe-top',
    '--left-stack-safe-bottom',
    '--left-stack-centered-height',
    '--right-stack-safe-top',
    '--right-stack-max-height',
  ]) {
    if (stack.style.getPropertyValue(name)) stack.style.removeProperty(name);
  }
  if (stack.dataset.layoutMode !== 'polcam')
    stack.dataset.layoutMode = 'polcam';

  for (const panel of stack.querySelectorAll(':scope > [data-panel-id]')) {
    if (panel.classList.contains('layout-auto-collapsed')) {
      panel.classList.remove('collapsed', 'layout-auto-collapsed');
      onRestore(panel);
    }
    if (panel.hasAttribute('aria-hidden')) panel.removeAttribute('aria-hidden');
    for (const name of [
      '--left-panel-allocated-height',
      '--right-panel-allocated-height',
    ]) {
      if (panel.style.getPropertyValue(name)) panel.style.removeProperty(name);
    }
  }
}
