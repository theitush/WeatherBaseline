import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { UnitSystem } from '../utils/units';
import { detectDefaultSystem } from '../utils/units';

// Resolve the effective unit system on first render: an explicit saved choice
// wins, otherwise fall back to the timezone-based default. A manual flip in the
// settings menu persists to localStorage, so it sticks across visits.
function getInitialSystem(): UnitSystem {
  try {
    const saved = localStorage.getItem('units');
    if (saved === 'metric' || saved === 'imperial') return saved;
  } catch {
    /* ignore */
  }
  return detectDefaultSystem();
}

export interface UnitsState {
  system: UnitSystem;
  setSystem: (s: UnitSystem) => void;
  toggleUnits: () => void;
}

// Context so every display component reads the same system from one provider,
// rather than each useUnits() call holding its own independent state.
export const UnitsContext = createContext<UnitsState | undefined>(undefined);

export function useUnitsState(): UnitsState {
  const [system, setSystem] = useState<UnitSystem>(getInitialSystem);

  useEffect(() => {
    try {
      localStorage.setItem('units', system);
    } catch {
      /* ignore */
    }
  }, [system]);

  const toggleUnits = useCallback(
    () => setSystem((s) => (s === 'metric' ? 'imperial' : 'metric')),
    []
  );

  return { system, setSystem, toggleUnits };
}

export function useUnits(): UnitsState {
  const ctx = useContext(UnitsContext);
  if (!ctx) throw new Error('useUnits must be used within a UnitsProvider');
  return ctx;
}
