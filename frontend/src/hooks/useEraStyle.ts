import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { EraStyle } from '../utils/eras';

// How the era-split histogram tells its three eras apart — 'shade' (three
// shades of the metric hue) or 'contour' (one fill, outline colour per era).
// A flip in the settings menu persists to localStorage like units and theme.
function getInitialStyle(): EraStyle {
  try {
    const saved = localStorage.getItem('eraStyle');
    if (saved === 'shade' || saved === 'contour') return saved;
  } catch {
    /* ignore */
  }
  return 'shade';
}

export interface EraStyleState {
  eraStyle: EraStyle;
  toggleEraStyle: () => void;
}

export const EraStyleContext = createContext<EraStyleState | undefined>(undefined);

export function useEraStyleState(): EraStyleState {
  const [eraStyle, setEraStyle] = useState<EraStyle>(getInitialStyle);

  useEffect(() => {
    try {
      localStorage.setItem('eraStyle', eraStyle);
    } catch {
      /* ignore */
    }
  }, [eraStyle]);

  const toggleEraStyle = useCallback(
    () => setEraStyle((s) => (s === 'shade' ? 'contour' : 'shade')),
    []
  );

  return { eraStyle, toggleEraStyle };
}

export function useEraStyle(): EraStyleState {
  const ctx = useContext(EraStyleContext);
  if (!ctx) throw new Error('useEraStyle must be used within an EraStyleContext provider');
  return ctx;
}
