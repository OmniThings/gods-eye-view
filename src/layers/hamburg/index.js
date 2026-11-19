import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';

const SIGNAL_REFRESH_MS = 10_000;
const FRESH_MS = 60_000;
const MAX_SIGNAL_ROWS = 5;
const PRESENTATION = Object.freeze({
  signals: {
    id: 'hamburg-signals',
    name: 'Hamburg · sygnalizacja',
    icon: '◉',
    color: '#8ce7ed',
    size: 7,
    selectedSize: 11,
    label: 'SYGNALIZACJA · lokalizacja węzła',
  },
  rsu: {
    id: 'hamburg-rsu',
    name: 'Hamburg · RSU',
    icon: '◯',
    color: '#ffc477',
    size: 18,
    selectedSize: 24,
    label: 'RSU · ewidencja R-ITS-S',
  },
});

const compact = (value, max = 100) =>
  String(value ?? '')
    .trim()
    .slice(0, max);
const timestamp = (value) => {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};
const dateLabel = (value) => {
  const time = timestamp(value);
  return time === null
    ? 'brak daty'
    : new Date(time).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
};

/** Describe observation freshness at acquisition time, never as a perpetual live phase. */
export function hamburgSignalDetails(snapshot, fallbackTime = Date.now()) {
  if (!snapshot?.available || !snapshot.rows?.length)
    return ['Brak dostępnych odczytów grup sygnałowych'];
  const fetchedAt = timestamp(snapshot.fetchedAt) ?? fallbackTime;
  const rows = snapshot.rows.slice(0, MAX_SIGNAL_ROWS);
  const details = [
    'Dane procesowe LSA · nie radiowy SPaT',
    `Pobrano: ${dateLabel(fetchedAt)}`,
    'Świeżość poniżej: ≤60 s w chwili pobrania',
  ];
  for (const row of rows) {
    const observed = timestamp(row.observedAt);
    const fresh =
      row.fresh === true &&
      observed !== null &&
      fetchedAt >= observed &&
      fetchedAt - observed <= FRESH_MS;
    const time =
      observed === null
        ? 'brak czasu'
        : new Date(observed).toISOString().slice(11, 19) + ' UTC';
    details.push(
      `${compact(row.name, 16)}: ${compact(row.state, 18)} · ${time} · ${fresh ? 'świeży' : 'STARY'}`,
    );
  }
  const oldest = rows
    .map((row) => timestamp(row.observedAt))
    .filter((time) => time !== null);
  if (oldest.length)
    details.push(`Najstarszy pomiar: ${dateLabel(Math.min(...oldest))}`);
  details.push(
    `Pokazano ${rows.length} z ${snapshot.rows.length}${snapshot.truncated ? '+' : ''} grup`,
  );
  return details;
}

/** An inventory layer with abortable polling confined to the selected signal node. */
export function createHamburgLayer({
  kind,
  source,
  services,
  eventTarget = typeof window === 'undefined' ? null : window,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  handlerFactory = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
} = {}) {
  const appearance = PRESENTATION[kind];
  if (!appearance || typeof source?.getSnapshot !== 'function')
    throw new TypeError(
      'Hamburg requires a supported kind and a snapshot source',
    );
  const { id, name, icon, color } = appearance;
  const context = services.context;
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let destroyed = false;
  let request = null;
  let signalRequest = null;
  let signalTimer = null;
  let selectedId = null;
  let selectedSnapshot = null;
  let rows = new Map();
  let lastUpdate = null;
  let error = null;
  let loading = false;
  let credit = null;
  let clickHandler = null;
  let removeTracking = null;
  const contextId = (rowId) => `${id}:${rowId}`;
  const render = () => services.render.governorRequestRender('hamburg-layer');

  function stopSignals() {
    if (signalTimer !== null) cancel(signalTimer);
    signalTimer = null;
    signalRequest?.abort();
    signalRequest = null;
    selectedSnapshot = null;
  }

  function clearSelection({ clearContext = false } = {}) {
    const entity =
      selectedId && dataSource?.entities.getById(contextId(selectedId));
    if (entity) entity.point.pixelSize = appearance.size;
    selectedId = null;
    stopSignals();
    if (clearContext) context.clearSelectedEntityContextForLayer(id);
    render();
  }

  function stillSelected(rowId) {
    return (
      enabled &&
      !destroyed &&
      selectedId === rowId &&
      context.getSelectedEntityContext()?.id === contextId(rowId)
    );
  }

  function detailsFor(row) {
    const details = [
      appearance.label,
      compact(row.status),
      `ID: ${compact(row.nodeId || row.id, 48)}`,
    ];
    if (kind === 'rsu') {
      if (row.services?.length)
        details.push(
          `Usługi: ${row.services.map((value) => compact(value, 35)).join(', ')}`,
        );
      if (row.projects?.length)
        details.push(
          `Projekty: ${row.projects.map((value) => compact(value, 35)).join(', ')}`,
        );
    }
    details.push(`Ewidencja pobrana: ${dateLabel(lastUpdate)}`);
    details.push('Źródło: Hamburg Open Data · link w atrybucji mapy');
    return details.filter(Boolean);
  }

  function updateCard(row, extra = []) {
    const entity = dataSource?.entities.getById(contextId(row.id));
    if (!entity) return;
    const inventoryDetails =
      kind === 'signals' && extra.length
        ? [
            appearance.label,
            `Węzeł: ${compact(row.nodeId || row.id, 48)} · Hamburg LSBG`,
          ]
        : detailsFor(row);
    entity.gevLabelModel = {
      title: compact(row.name || row.nodeId || row.id, 48),
      details: [...inventoryDetails, ...extra],
      accent: color,
      selected: true,
      cardStyle: 'tactical',
      anchorRadiusPx: 10,
      anchorRadiusScale: null,
    };
    services.refreshReadout(entity);
    render();
  }

  async function refreshSignals(row) {
    if (!stillSelected(row.id)) return;
    signalRequest?.abort();
    const active = new AbortController();
    signalRequest = active;
    // The card dates freshness to acquisition, so pending requests cannot
    // turn an old observation into a purported current phase.
    updateCard(
      row,
      selectedSnapshot
        ? hamburgSignalDetails(selectedSnapshot, now())
        : ['Pobieranie grup sygnałowych…'],
    );
    try {
      const snapshot = await source.getSignals(row.nodeId, {
        signal: active.signal,
      });
      if (
        active.signal.aborted ||
        signalRequest !== active ||
        !stillSelected(row.id)
      )
        return;
      selectedSnapshot = snapshot;
      updateCard(row, hamburgSignalDetails(snapshot, now()));
    } catch (failure) {
      if (
        active.signal.aborted ||
        signalRequest !== active ||
        !stillSelected(row.id)
      )
        return;
      selectedSnapshot = null;
      updateCard(row, ['Odczyty grup sygnałowych niedostępne']);
    } finally {
      if (signalRequest === active) {
        signalRequest = null;
        if (stillSelected(row.id))
          signalTimer = schedule(() => {
            signalTimer = null;
            void refreshSignals(row);
          }, SIGNAL_REFRESH_MS);
      }
    }
  }

  function select(rowId) {
    const row = rows.get(String(rowId));
    if (!enabled || destroyed || !row) return false;
    clearSelection();
    selectedId = String(row.id);
    const entity = dataSource.entities.getById(contextId(row.id));
    entity.point.pixelSize = appearance.selectedSize;
    updateCard(row);
    context.selectEntityContext(entity);
    if (
      kind === 'signals' &&
      row.nodeId &&
      typeof source.getSignals === 'function'
    )
      void refreshSignals(row);
    return true;
  }

  function onSelection(event) {
    if (selectedId && event.detail?.id !== contextId(selectedId))
      clearSelection();
  }
  function onClear(event) {
    if (!event.detail?.layerId || event.detail.layerId === id) clearSelection();
  }
  const onAircraft = () => clearSelection();

  function setCredit(url) {
    if (credit) viewer.creditDisplay?.removeStaticCredit(credit);
    credit = null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
        return;
      const escaped = parsed.href.replace(
        /[&<>"']/g,
        (character) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[character],
      );
      const liveLink =
        kind === 'signals'
          ? ' · <a href="https://tld.iot.hamburg.de/v1.1" target="_blank" rel="noopener noreferrer">Odczyty LSA / SensorThings</a>'
          : '';
      credit = new Cesium.Credit(
        `<span>${kind === 'rsu' ? 'RSU' : 'Sygnalizacja'}: <a href="${escaped}" target="_blank" rel="noopener noreferrer">Freie und Hansestadt Hamburg, Landesbetrieb Straßen, Brücken und Gewässer</a> · <a href="https://www.govdata.de/dl-de/by-2-0" target="_blank" rel="noopener noreferrer">DL-DE BY 2.0</a> · dane przetworzone${kind === 'rsu' ? ', usługi pogrupowane według lokalizacji' : ', lokalizacje węzłów'}${liveLink}</span>`,
        false,
      );
      if (enabled) viewer.creditDisplay?.addStaticCredit(credit);
    } catch {
      // Malformed source links never become markup or executable URLs.
    }
  }

  const layer = {
    id,
    name,
    icon,
    source: 'Hamburg Open Data · EWIDENCJA',
    updateInterval: 300_000,
    async init(host) {
      if (viewer || destroyed)
        throw new Error('Hamburg layer cannot be initialized twice');
      viewer = host;
      const created = new Cesium.CustomDataSource(id);
      created.show = false;
      dataSource = created;
      await viewer.dataSources.add(created);
      if (destroyed) {
        viewer.dataSources.remove(created, true);
        return;
      }
      clickHandler = handlerFactory(viewer.scene.canvas);
      clickHandler.setInputAction((click) => {
        if (!enabled || !isPointerFree()) return;
        const picked = viewer.scene.pick(click.position);
        const entity = picked?.id;
        if (entity?.gevHamburgLayerId === id) {
          if (selectedId === entity.gevHamburgRowId)
            clearSelection({ clearContext: true });
          else select(entity.gevHamburgRowId);
        } else if (!picked && selectedId)
          clearSelection({ clearContext: true });
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      eventTarget?.addEventListener('gev:entity-selected', onSelection);
      eventTarget?.addEventListener('gev:entity-selection-cleared', onClear);
      eventTarget?.addEventListener(
        'gev:awareness-subject-selected',
        onAircraft,
      );
      removeTracking = viewer.trackedEntityChanged?.addEventListener(() => {
        if (viewer.trackedEntity) clearSelection({ clearContext: true });
      });
    },
    enable() {
      if (destroyed) return false;
      enabled = true;
      dataSource.show = true;
      if (credit) viewer.creditDisplay?.addStaticCredit(credit);
      services.picking.registerPickOwner(id, (pickedId) =>
        String(pickedId).startsWith(`${id}:`),
      );
      render();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled || destroyed) return false;
      request?.abort();
      const active = new AbortController();
      request = active;
      const abort = () => active.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) active.abort();
      loading = true;
      error = null;
      try {
        const snapshot = await source.getSnapshot({
          kind,
          signal: active.signal,
        });
        if (
          active.signal.aborted ||
          request !== active ||
          !enabled ||
          destroyed
        )
          return false;
        const retainedId = selectedId;
        const retained = retainedId && stillSelected(retainedId);
        stopSignals();
        const retainedContextIds = new Set(
          snapshot.rows.map((row) => contextId(row.id)),
        );
        dataSource.entities.suspendEvents();
        try {
          // Keep each retained Entity alive. Removing and re-adding an ID in
          // one suspended Cesium batch suppresses its collection event and
          // leaves the visualizer (and picking) holding the old Entity.
          for (const entity of [...dataSource.entities.values]) {
            if (!retainedContextIds.has(entity.id))
              dataSource.entities.remove(entity);
          }
          context.removeEntityContextsForLayer(id, {
            retainIds: retainedContextIds,
          });
          rows = new Map();
          lastUpdate = snapshot.fetchedAt;
          for (const row of snapshot.rows) {
            const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 4);
            const entity =
              dataSource.entities.getById(contextId(row.id)) ||
              dataSource.entities.add({
                id: contextId(row.id),
                point: {
                  pixelSize: appearance.size,
                  color:
                    kind === 'rsu'
                      ? Cesium.Color.fromCssColorString(color).withAlpha(0.12)
                      : Cesium.Color.fromCssColorString(color),
                  outlineColor: Cesium.Color.fromCssColorString(
                    kind === 'rsu' ? color : '#10202c',
                  ),
                  outlineWidth: kind === 'rsu' ? 3 : 2,
                  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                  distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
                    0,
                    150_000,
                  ),
                  scaleByDistance: new Cesium.NearFarScalar(
                    500,
                    1.3,
                    100_000,
                    0.65,
                  ),
                },
              });
            entity.name = compact(row.name);
            entity.position = position;
            entity.point.pixelSize = appearance.size;
            entity.gevHamburgLayerId = id;
            entity.gevHamburgRowId = String(row.id);
            entity.gevTrackedId = contextId(row.id);
            entity.gevDisplayPosition = () => position;
            rows.set(String(row.id), row);
            context.registerEntityContext(entity, {
              id: contextId(row.id),
              layerId: id,
              layerName: name,
              label: compact(row.name),
              source: 'Hamburg Open Data',
              dataSource,
              latitude: row.lat,
              longitude: row.lon,
              properties: { ...row, inventoryFetchedAt: lastUpdate },
            });
          }
        } finally {
          dataSource.entities.resumeEvents();
        }
        setCredit(snapshot.sourceUrl);
        selectedId = null;
        if (retained && rows.has(retainedId)) select(retainedId);
        render();
        return true;
      } catch (failure) {
        if (
          !active.signal.aborted &&
          request === active &&
          enabled &&
          !destroyed
        ) {
          error = compact(failure?.message || 'Nie udało się pobrać ewidencji');
          render();
        }
        return false;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === active) {
          request = null;
          loading = false;
        }
      }
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      loading = false;
      clearSelection({ clearContext: true });
      if (dataSource) dataSource.show = false;
      if (credit) viewer?.creditDisplay?.removeStaticCredit(credit);
      services.picking.unregisterPickOwner(id);
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      layer.disable();
      clickHandler?.destroy();
      clickHandler = null;
      removeTracking?.();
      eventTarget?.removeEventListener('gev:entity-selected', onSelection);
      eventTarget?.removeEventListener('gev:entity-selection-cleared', onClear);
      eventTarget?.removeEventListener(
        'gev:awareness-subject-selected',
        onAircraft,
      );
      context.removeEntityContextsForLayer(id);
      if (dataSource) viewer?.dataSources.remove(dataSource, true);
      dataSource = null;
      rows.clear();
    },
    getStats() {
      return {
        count: rows.size,
        lastUpdate,
        loading,
        error,
        statusMessage:
          kind === 'rsu'
            ? 'EWIDENCJA · lokalizacje RSU, status online nieznany'
            : 'EWIDENCJA · wybierz węzeł, aby sprawdzić grupy sygnałowe',
      };
    },
  };
  return layer;
}
