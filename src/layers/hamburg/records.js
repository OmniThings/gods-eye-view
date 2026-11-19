/** Hamburg inventory positions describe junctions/sites, not individual signal heads or antennas. */
export const HAMBURG_DATASETS = Object.freeze({
  signals: 'https://api.hamburg.de/datasets/v1/lichtsignalanlagen',
  rsu: 'https://api.hamburg.de/datasets/v1/its_dienste_hamburg',
  live: 'https://tld.iot.hamburg.de/v1.1',
});

const clean = (value) =>
  typeof value === 'string' ? value.trim().slice(0, 240) : '';
export function hamburgNodeId(value) {
  const text = String(value ?? '').trim();
  return /^\d{1,8}$/.test(text) ? String(Number(text)) : null;
}

function coordinates(geometry) {
  const pair =
    geometry?.type === 'Point'
      ? geometry.coordinates
      : geometry?.type === 'MultiPoint' && geometry.coordinates?.length === 1
        ? geometry.coordinates[0]
        : null;
  if (!Array.isArray(pair)) return null;
  const [lon, lat] = pair;
  // Reject swapped axes and data outside the Hamburg region instead of drawing false sites.
  return Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= 9 &&
    lon <= 11 &&
    lat >= 53 &&
    lat <= 54
    ? { lon, lat }
    : null;
}

export function normalizeHamburgInventory(payload, kind) {
  if (
    !['signals', 'rsu'].includes(kind) ||
    payload?.type !== 'FeatureCollection' ||
    !Array.isArray(payload.features) ||
    payload.features.length > 5000
  )
    throw new Error('Invalid Hamburg inventory');
  const sites = new Map();
  for (const feature of payload.features) {
    const props = feature?.properties;
    if (!props || typeof props !== 'object')
      throw new Error('Invalid Hamburg feature');
    // Only this explicitly documented device category establishes RSU membership.
    if (kind === 'rsu' && props.device_type !== 'R-ITS-S') continue;
    const point = coordinates(feature.geometry);
    if (!point) throw new Error('Invalid Hamburg coordinates');
    const nodeId = hamburgNodeId(
      kind === 'signals' ? props.knoten : props.infrastructure_number,
    );
    const locationId = hamburgNodeId(props.location_id);
    const infrastructureId = hamburgNodeId(props.infrastructure_id);
    if (kind === 'signals' ? !nodeId : !locationId || !infrastructureId)
      throw new Error('Missing Hamburg site identifier');
    const id =
      kind === 'signals'
        ? `signals-${nodeId}`
        : `rsu-${locationId}-${infrastructureId}`;
    const name = clean(
      kind === 'signals' ? props.LSA_Name : props.infrastrucutre_name,
    );
    const existing = sites.get(id);
    if (existing) {
      if (
        kind === 'signals' ||
        Math.abs(existing.lat - point.lat) > 0.00001 ||
        Math.abs(existing.lon - point.lon) > 0.00001
      )
        throw new Error('Conflicting Hamburg site records');
      for (const [key, value] of [
        ['services', props.purpose],
        ['projects', props.project_name],
      ]) {
        const text = clean(value);
        if (text && !existing[key].includes(text)) existing[key].push(text);
      }
      existing.registryEntries++;
      continue;
    }
    sites.set(id, {
      id,
      nodeId,
      kind,
      name: name || `Hamburg ${nodeId ?? locationId}`,
      ...point,
      status: 'EWIDENCJA · status online nieznany',
      services:
        kind === 'rsu' && clean(props.purpose) ? [clean(props.purpose)] : [],
      projects:
        kind === 'rsu' && clean(props.project_name)
          ? [clean(props.project_name)]
          : [],
      registryEntries: 1,
      sourceUrl: HAMBURG_DATASETS[kind],
    });
  }
  return [...sites.values()];
}

// TLD unitOfMeasurement.definition; these values are per lane/signal group, never a whole junction.
const SIGNAL_STATES = Object.freeze({
  0: 'wyłączony',
  1: 'czerwony',
  2: 'żółty',
  3: 'zielony',
  4: 'czerwono-żółty',
  5: 'żółty migający',
  6: 'zielony migający',
  9: 'nieznany',
});

export function normalizeHamburgSignals(payload, nodeId, now = Date.now()) {
  if (!Array.isArray(payload?.value) || payload.value.length > 64)
    throw new Error('Invalid Hamburg signal response');
  const result = [];
  for (const stream of payload.value) {
    if (
      stream?.properties?.layerName !== 'primary_signal' ||
      hamburgNodeId(stream?.Thing?.properties?.trafficLightsID) !== nodeId
    )
      throw new Error(
        'Hamburg signal does not belong to the selected junction',
      );
    const observation = stream.Observations?.[0];
    const time =
      typeof observation?.phenomenonTime === 'string'
        ? Date.parse(observation.phenomenonTime)
        : NaN;
    const code = observation?.result;
    const known =
      typeof code === 'number' && Object.hasOwn(SIGNAL_STATES, code);
    result.push({
      id: String(stream['@iot.id']),
      name:
        [clean(stream.properties.signalGroupID), clean(stream.Thing?.name)]
          .filter(Boolean)
          .join(' · ') || 'Grupa sygnałowa',
      state: known ? SIGNAL_STATES[code] : 'nieznany',
      observedAt: Number.isFinite(time) ? new Date(time).toISOString() : null,
      fresh:
        known &&
        code !== 9 &&
        Number.isFinite(time) &&
        time <= now &&
        now - time <= 60000,
    });
  }
  return result;
}
