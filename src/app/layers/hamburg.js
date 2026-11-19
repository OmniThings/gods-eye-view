import { createHamburgLayer } from '../../layers/hamburg/index.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import * as render from '../../renderGovernor.js';
import { refreshTrackedReadout } from '../../data/trackedReadout.js';

/** Bind Hamburg inventory layers to the application's existing selection owners. */
export function createApplicationHamburg({ source }) {
  return ['signals', 'rsu'].map((kind) =>
    createHamburgLayer({
      kind,
      source,
      services: {
        context,
        picking,
        render,
        refreshReadout: refreshTrackedReadout,
      },
    }),
  );
}
