import { useSyncExternalStore } from 'react';
import {
  eraColorOverrides,
  subscribeEraColorOverrides,
  type EraColorOverrides,
} from '../utils/eraColorOverrides';

/**
 * Subscribe to the era-colour overrides (#73).
 *
 * The charts pick their colours inside a d3 draw effect whose dependency array
 * decides when it re-runs, so a component re-render alone would not repaint a
 * changed swatch. Every chart that inks eras therefore reads this and lists it
 * in that array — the store hands back a new object identity on each change and
 * the same one otherwise, so it fires exactly when a colour moved and never on
 * an unrelated render.
 */
export function useEraColorOverrides(): EraColorOverrides {
  return useSyncExternalStore(
    subscribeEraColorOverrides,
    eraColorOverrides,
    eraColorOverrides
  );
}
