import {
  HAMBURG_DATASETS,
  hamburgNodeId,
  normalizeHamburgInventory,
  normalizeHamburgSignals,
} from './records.js';

const ITEMS = Object.freeze({
  signals: `${HAMBURG_DATASETS.signals}/collections/lsa_knotengrunddaten/items`,
  rsu: `${HAMBURG_DATASETS.rsu}/collections/its_iot_registry/items`,
});

/** Public read-only Hamburg APIs. No keys, proxy, whole-city live polling or radio access. */
export function createHamburgSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 15000,
} = {}) {
  async function request(url, signal) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('Hamburg request timed out')),
      timeoutMs,
    );
    try {
      const response = await fetchImpl(String(url), {
        signal: controller.signal,
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Hamburg HTTP ${response.status}`);
      const data = await response.json();
      controller.signal.throwIfAborted();
      return data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  return {
    async getSnapshot({ kind, signal } = {}) {
      if (!Object.hasOwn(ITEMS, kind))
        throw new Error('Unknown Hamburg inventory');
      let url = new URL(ITEMS[kind]);
      url.searchParams.set('f', 'json');
      url.searchParams.set('limit', '2000');
      if (kind === 'rsu')
        url.searchParams.set('filter', "device_type = 'R-ITS-S'");
      const features = [];
      const visited = new Set();
      let matched = null;
      while (url) {
        if (visited.has(url.href) || visited.size >= 10)
          throw new Error('Hamburg pagination limit');
        visited.add(url.href);
        const page = await request(url, signal);
        if (page?.type !== 'FeatureCollection' || !Array.isArray(page.features))
          throw new Error('Invalid Hamburg inventory page');
        if (matched == null && Number.isInteger(page.numberMatched))
          matched = page.numberMatched;
        if (features.length + page.features.length > 5000)
          throw new Error('Hamburg inventory limit');
        features.push(...page.features);
        const next = page.links?.find((link) => link.rel === 'next')?.href;
        url = next ? new URL(next, url) : null;
        if (url && `${url.origin}${url.pathname}` !== ITEMS[kind])
          throw new Error('Unexpected Hamburg pagination URL');
      }
      if (matched != null && matched !== features.length)
        throw new Error('Incomplete Hamburg inventory');
      const rows = normalizeHamburgInventory(
        { type: 'FeatureCollection', features },
        kind,
      );
      signal?.throwIfAborted();
      return { rows, fetchedAt: now(), sourceUrl: HAMBURG_DATASETS[kind] };
    },

    async getSignals(node, { signal } = {}) {
      const nodeId = hamburgNodeId(node);
      if (!nodeId) throw new Error('Invalid Hamburg junction identifier');
      const url = new URL(`${HAMBURG_DATASETS.live}/Datastreams`);
      url.searchParams.set('$top', '64');
      url.searchParams.set(
        '$filter',
        `properties/layerName eq 'primary_signal' and Thing/properties/trafficLightsID eq '${nodeId}'`,
      );
      url.searchParams.set(
        '$expand',
        'Observations($top=1;$orderby=phenomenonTime desc),Thing',
      );
      const payload = await request(url, signal);
      const fetchedAt = now();
      const rows = normalizeHamburgSignals(payload, nodeId, fetchedAt);
      signal?.throwIfAborted();
      return {
        rows,
        available: rows.length > 0,
        fetchedAt,
        sourceUrl: String(url),
        truncated: Boolean(payload['@iot.nextLink']),
      };
    },
  };
}
