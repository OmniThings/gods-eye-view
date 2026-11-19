import test from 'node:test';
import assert from 'node:assert/strict';
import { createHamburgSource } from './source.js';
import { normalizeHamburgInventory, normalizeHamburgSignals } from './records.js';

const point = { type: 'Point', coordinates: [9.99, 53.55] };
const feature = (properties, geometry = point) => ({ type: 'Feature', geometry, properties });
const collection = (...features) => ({ type: 'FeatureCollection', features });
const signal = (id = 1556) => feature({ knoten: id, LSA_Name: ' Dammtor ' }, { type: 'MultiPoint', coordinates: [[9.99, 53.55]] });
const rsu = (extra = {}) => feature({ device_type: 'R-ITS-S', device_id: 2, location_id: 13, infrastructure_id: 13, infrastructure_number: 19, infrastrucutre_name: 'Landungsbrücken', purpose: 'V2X (SPaT/MAP)', project_name: 'TAVF-HH', ...extra });
const now = Date.parse('2026-11-19T17:30:00Z');
const stream = (result, time = '2026-11-19T17:29:40Z', node = '1556') => ({
  '@iot.id': 70470, properties: { layerName: 'primary_signal', signalGroupID: 'K7' },
  Thing: { name: '1556_1', properties: { trafficLightsID: node } },
  Observations: [{ result, phenomenonTime: time }],
});
const response = (data) => ({ ok: true, json: async () => data });

test('junction positions normalize MultiPoint and trim source names', () => {
  const rows = normalizeHamburgInventory(collection(signal()), 'signals');
  assert.equal(rows[0].nodeId, '1556');
  assert.equal(rows[0].name, 'Dammtor');
  assert.equal(rows[0].lon, 9.99);
  assert.match(rows[0].status, /online nieznany/);
});

test('RSU membership is explicit; device category does not identify physical sites', () => {
  const rows = normalizeHamburgInventory(collection(
    rsu(), rsu({ purpose: 'Bus priority', project_name: 'BiDiMoVe' }),
    rsu({ location_id: 24, infrastructure_id: 24 }),
    rsu({ device_type: 'camera' }),
  ), 'rsu');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].services, ['V2X (SPaT/MAP)', 'Bus priority']);
  assert.deepEqual(rows[0].projects, ['TAVF-HH', 'BiDiMoVe']);
  assert.equal(rows[0].registryEntries, 2);
});

test('wrong axes, duplicate junctions and conflicting RSU sites reject the snapshot', () => {
  assert.throws(() => normalizeHamburgInventory(collection(feature({ knoten: 19 }, { type: 'Point', coordinates: [53.55, 9.99] })), 'signals'));
  assert.throws(() => normalizeHamburgInventory(collection(signal(), signal()), 'signals'));
  const other = rsu(); other.geometry = { type: 'Point', coordinates: [10.2, 53.7] };
  assert.throws(() => normalizeHamburgInventory(collection(rsu(), other), 'rsu'));
});

test('per-group signal codes, stale/future times and unknown results remain distinct', () => {
  assert.equal(normalizeHamburgSignals({ value: [stream(3)] }, '1556', now)[0].state, 'zielony');
  assert.equal(normalizeHamburgSignals({ value: [stream(3)] }, '1556', now)[0].fresh, true);
  for (const row of [stream(1, '2026-11-19T17:28:59Z'), stream(3, '2026-11-19T17:30:01Z'), stream(9), stream(8), stream('3'), stream(null), stream(3, 'bad-time')]) {
    assert.equal(normalizeHamburgSignals({ value: [row] }, '1556', now)[0].fresh, false);
  }
  assert.throws(() => normalizeHamburgSignals({ value: [stream(1, undefined, '19')] }, '1556', now));
});

test('inventory follows bounded official pagination before publishing a complete snapshot', async () => {
  const calls = [];
  const source = createHamburgSource({ now: () => now, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.credentials, 'omit');
    if (calls.length === 1) return response({ ...collection(signal()), numberMatched: 2, links: [{ rel: 'next', href: '?f=json&offset=1' }] });
    return response(collection(signal(19)));
  }});
  const snapshot = await source.getSnapshot({ kind: 'signals' });
  assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.fetchedAt, now);
  assert.equal(calls.length, 2);
});

test('partial data, foreign pagination and HTTP errors never masquerade as complete inventory', async () => {
  for (const payload of [
    { ...collection(signal()), numberMatched: 2 },
    { ...collection(signal()), links: [{ rel: 'next', href: 'https://example.org/next' }] },
    { data: [] },
  ]) {
    const source = createHamburgSource({ fetchImpl: async () => response(payload) });
    await assert.rejects(source.getSnapshot({ kind: 'signals' }));
  }
  const source = createHamburgSource({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(source.getSnapshot({ kind: 'rsu' }), /503/);
});

test('on-demand live query is junction-scoped, bounded and reports truncation', async () => {
  let requested;
  const source = createHamburgSource({ now: () => now, fetchImpl: async (url) => {
    requested = new URL(url);
    return response({ value: [stream(1)], '@iot.nextLink': 'next-page' });
  }});
  const snapshot = await source.getSignals('1556');
  assert.equal(requested.searchParams.get('$top'), '64');
  assert.match(requested.searchParams.get('$filter'), /trafficLightsID eq '1556'/);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.rows[0].state, 'czerwony');
  await assert.rejects(source.getSignals("1556' or true"), /identifier/);
});

test('no published datastreams is an explicit unavailable result', async () => {
  const source = createHamburgSource({ fetchImpl: async () => response({ value: [] }) });
  assert.equal((await source.getSignals('1556')).available, false);
});

test('abort during body decoding prevents a late successful snapshot', async () => {
  const controller = new AbortController();
  const source = createHamburgSource({ fetchImpl: async () => ({ ok: true, json: async () => {
    controller.abort(); return collection(signal());
  }}) });
  await assert.rejects(source.getSnapshot({ kind: 'signals', signal: controller.signal }), { name: 'AbortError' });
});

test('source times out a stalled request and propagates caller cancellation', async () => {
  const stalled = async (_url, { signal: abortSignal }) => new Promise((_resolve, reject) => {
    abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
  });
  const source = createHamburgSource({ fetchImpl: stalled, timeoutMs: 15 });
  await assert.rejects(source.getSignals('1556'), /timed out/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.getSignals('1556', { signal: controller.signal }), { name: 'AbortError' });
});
