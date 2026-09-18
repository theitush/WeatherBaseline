import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import { useUnits } from '../hooks/useUnits';
import { useEraStyle } from '../hooks/useEraStyle';
import './SettingsMenu.css';

// Gear button in the header that opens a small popover with two single toggle
// buttons stacked vertically: one flips the theme (sun ⇄ moon), one flips the
// units (°C ⇄ °F). Each button shows the current state and toggles on click.
const SettingsMenu: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  const { system, toggleUnits } = useUnits();
  const { eraStyle, toggleEraStyle } = useEraStyle();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside-click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isDark = theme === 'dark';
  const isImperial = system === 'imperial';

  return (
    <div className="settings-menu" ref={rootRef}>
      <button
        type="button"
        className="settings-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label="Settings"
        aria-haspopup="true"
        aria-expanded={open}
        title="Settings"
      >
        {/* Gear (Feather "settings") */}
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div className="settings-popover" role="menu">
          {/* Theme toggle — shows the current mode, flips on click. */}
          <button
            type="button"
            className="settings-toggle"
            onClick={toggleTheme}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? (
              // Moon (dark mode active)
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 1 0 10.5 10.5z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              // Sun (light mode active)
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.6" />
                <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2L19 19M19 5l-1.8 1.8M6.8 17.2L5 19" />
                </g>
              </svg>
            )}
          </button>

          {/* Units toggle — shows the current system, flips on click. */}
          <button
            type="button"
            className="settings-toggle settings-toggle-glyph"
            onClick={toggleUnits}
            aria-label={isImperial ? 'Switch to metric units' : 'Switch to imperial units'}
            title={isImperial ? 'Switch to metric (°C, km)' : 'Switch to imperial (°F, mi)'}
          >
            {isImperial ? '°F' : '°C'}
          </button>

          {/* Era-style toggle (local test, #62) — how the histogram's three eras
              are told apart: three shades of the metric hue, or one fill with
              the outline colour changing per era. Shows the current style. */}
          <button
            type="button"
            className="settings-toggle"
            onClick={toggleEraStyle}
            aria-label={eraStyle === 'shade' ? 'Switch eras to contour style' : 'Switch eras to shade style'}
            title={eraStyle === 'shade' ? 'Eras: shades → switch to contours' : 'Eras: contours → switch to shades'}
          >
            {eraStyle === 'shade' ? (
              // Three filled swatches, light → dark
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="4" width="18" height="5" fill="currentColor" opacity="0.3" />
                <rect x="3" y="10" width="18" height="5" fill="currentColor" opacity="0.6" />
                <rect x="3" y="16" width="18" height="5" fill="currentColor" opacity="1" />
              </svg>
            ) : (
              // Three same-fill swatches, outlined
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="4" width="18" height="5" fill="currentColor" opacity="0.35" />
                <rect x="3" y="10" width="18" height="5" fill="currentColor" opacity="0.35" />
                <rect x="3" y="16" width="18" height="5" fill="currentColor" opacity="0.35" />
                <rect x="3.75" y="4.75" width="16.5" height="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2,1.5" />
                <rect x="3.75" y="10.75" width="16.5" height="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <rect x="3.75" y="16.75" width="16.5" height="3.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export default SettingsMenu;
