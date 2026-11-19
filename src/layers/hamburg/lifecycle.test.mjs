import test from 'node:test';
import assert from 'node:assert/strict';
import { createHamburgLayer, hamburgSignalDetails } from './index.js';

const row = (id = 'a', kind = 'signals') => ({
  id,
  nodeId: id === 'a' ? '001' : '002',
  kind,
  name: `Węzeł ${id}`,
  lat: 53.55,
  lon: 9.99,
  status: 'EWIDENCJA · status online nieznany',
  services: ['GLOSA'],
  projects: ['TAVF'],
  sourceUrl: 'https://api.hamburg.de/datasets/v1/test',
});
const inventory = (rows = [row()]) => ({
  rows,
  fetchedAt: 1_700_000_000_000,
  sourceUrl: 'https://api.hamburg.de/datasets/v1/test',
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function harness(source, kind = 'signals') {
  const events = new EventTarget();
  const sources = [];
  const contexts = new Map();
  const timers = new Map();
  const renderedCards = [];
  const owners = new Map();
  let selected = null;
  let picked = null;
  let click = null;
  let timerId = 0;
  const viewer = {
    scene: { canvas: {}, pick: () => picked },
    dataSources: {
      add(value) {
        sources.push(value);
        return Promise.resolve(value);
      },
      remove(value) {
        const index = sources.indexOf(value);
        if (index !== -1) sources.splice(index, 1);
      },
    },
    trackedEntityChanged: {
      addEventListener() {
        return () => {};
      },
    },
    creditDisplay: { addStaticCredit() {}, removeStaticCredit() {} },
  };
  const services = {
    render: { governorRequestRender() {} },
    picking: {
      registerPickOwner(id, callback) {
        owners.set(id, callback);
      },
      unregisterPickOwner(id) {
        owners.delete(id);
      },
    },
    refreshReadout(entity) {
      renderedCards.push({
        id: entity.id,
        details: [...entity.gevLabelModel.details],
      });
    },
    context: {
      registerEntityContext(entity, metadata) {
        contexts.set(metadata.id, { ...metadata, entity });
        entity.__gevContextId = metadata.id;
      },
      getSelectedEntityContext() {
        return selected;
      },
      selectEntityContext(entity) {
        selected = contexts.get(entity.__gevContextId);
        events.dispatchEvent(
          new CustomEvent('gev:entity-selected', { detail: selected }),
        );
      },
      clearSelectedEntityContextForLayer(id) {
        if (selected?.layerId !== id) return;
        selected = null;
        events.dispatchEvent(
          new CustomEvent('gev:entity-selection-cleared', {
            detail: { layerId: id },
          }),
        );
      },
      removeEntityContextsForLayer(id) {
        for (const [key, value] of contexts)
          if (value.layerId === id) contexts.delete(key);
        this.clearSelectedEntityContextForLayer(id);
      },
    },
  };
  const layer = createHamburgLayer({
    kind,
    source,
    services,
    eventTarget: events,
    now: () => 1_700_000_000_000,
    schedule(callback) {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    handlerFactory: () => ({
      setInputAction(callback) {
        click = callback;
      },
      destroy() {
        click = null;
      },
    }),
  });
  await layer.init(viewer);
  layer.enable(viewer);
  return {
    layer,
    viewer,
    sources,
    timers,
    events,
    contexts,
    renderedCards,
    owners,
    select(id) {
      picked = { id: sources[0].entities.getById(`${layer.id}:${id}`) };
      click({ position: {} });
    },
    selected: () => selected,
  };
}

test('only the selected signal node polls; a superseded response never replaces its card', async () => {
  const pending = [];
  const h = await harness({
    getSnapshot: async () => inventory([row('a'), row('b')]),
    getSignals(nodeId, options) {
      return new Promise((resolve) =>
        pending.push({ nodeId, ...options, resolve }),
      );
    },
  });
  await h.layer.update(h.viewer);
  assert.equal(
    pending.length,
    0,
    'city inventory does not trigger live polling',
  );
  h.select('a');
  assert.equal(pending[0].nodeId, '001');
  h.select('b');
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending[1].nodeId, '002');
  pending[0].resolve({
    available: true,
    rows: [
      {
        name: 'OLD',
        state: 'OLD',
        fresh: true,
        observedAt: '2023-11-14T22:13:20Z',
      },
    ],
  });
  await settle();
  assert.ok(
    !h.renderedCards.some((card) =>
      card.details.some((detail) => detail.includes('OLD')),
    ),
  );
  pending[1].resolve({
    available: true,
    rows: [
      {
        name: 'Grupa 2',
        state: 'STOP',
        fresh: true,
        observedAt: '2023-11-14T22:13:20Z',
      },
    ],
  });
  await settle();
  assert.match(h.renderedCards.at(-1).details.join('\n'), /Grupa 2: STOP/);
  assert.equal(h.timers.size, 1);
  h.events.dispatchEvent(
    new CustomEvent('gev:entity-selected', {
      detail: { id: 'another:object', layerId: 'another' },
    }),
  );
  assert.equal(h.timers.size, 0, 'another selection cancels future polling');
  h.layer.destroy();
  assert.equal(h.sources.length, 0);
  assert.equal(h.contexts.size, 0);
  assert.equal(h.owners.size, 0);
});

test('disable and destroy abort selected-node requests even if the provider ignores abort', async () => {
  for (const action of ['disable', 'destroy']) {
    let signal;
    let resolve;
    const h = await harness({
      getSnapshot: async () => inventory(),
      getSignals(_node, options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    await h.layer.update(h.viewer);
    h.select('a');
    h.layer[action]();
    assert.equal(signal.aborted, true);
    const count = h.renderedCards.length;
    resolve({ available: true, rows: [{ name: 'late', state: 'late' }] });
    await settle();
    assert.equal(h.renderedCards.length, count);
    assert.equal(h.timers.size, 0);
    h.layer.destroy();
  }
});

test('an old inventory cannot publish after disable and re-enable', async () => {
  let resolve;
  let signal;
  const h = await harness({
    getSnapshot(options) {
      signal = options.signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const loading = h.layer.update(h.viewer);
  h.layer.disable();
  h.layer.enable();
  assert.equal(signal.aborted, true);
  resolve(inventory());
  assert.equal(await loading, false);
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.sources[0].entities.values.length, 0);
  h.layer.destroy();
});

test('caller cancellation reaches inventory acquisition without publishing late data', async () => {
  let signal;
  let resolve;
  const h = await harness({
    getSnapshot(options) {
      signal = options.signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const caller = new AbortController();
  const loading = h.layer.update(h.viewer, { signal: caller.signal });
  caller.abort();
  assert.equal(signal.aborted, true);
  resolve(inventory());
  assert.equal(await loading, false);
  assert.equal(h.contexts.size, 0);
  h.layer.destroy();
});

test('RSU inventory remains inventory and never initiates signal polling', async () => {
  let liveCalls = 0;
  const h = await harness(
    {
      getSnapshot: async () => inventory([row('a', 'rsu')]),
      getSignals() {
        liveCalls++;
      },
    },
    'rsu',
  );
  await h.layer.update(h.viewer);
  h.select('a');
  assert.equal(liveCalls, 0);
  assert.match(
    h.renderedCards.at(-1).details.join('\n'),
    /status online nieznany/,
  );
  assert.match(h.renderedCards.at(-1).details.join('\n'), /GLOSA/);
  assert.equal(h.timers.size, 0);
  h.layer.destroy();
});

test('freshness is explicitly dated to acquisition and includes each observation time', () => {
  const observedAt = '2023-11-14T22:13:20Z';
  const time = Date.parse(observedAt);
  const data = {
    available: true,
    rows: [{ name: 'K1', state: 'STOP', observedAt, fresh: true }],
  };
  assert.match(
    hamburgSignalDetails(data, time + 1000).join('\n'),
    /22:13:20 UTC · świeży/,
  );
  assert.match(hamburgSignalDetails(data, time + 61000).join('\n'), /STARY/);
  assert.match(hamburgSignalDetails(data, time - 1000).join('\n'), /STARY/);
  const acquired = { ...data, fetchedAt: time + 1000 };
  assert.match(
    hamburgSignalDetails(acquired, time + 61000).join('\n'),
    /chwili pobrania/,
  );
  assert.match(
    hamburgSignalDetails(acquired, time + 61000).join('\n'),
    /22:13:20 UTC · świeży/,
  );
  assert.match(
    hamburgSignalDetails({ available: false, rows: [] }).join('\n'),
    /Brak dostępnych/,
  );
  assert.match(
    hamburgSignalDetails({ ...data, truncated: true }, time).join('\n'),
    /Pokazano 1 z 1\+/,
  );
});
