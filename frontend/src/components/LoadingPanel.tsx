import React from 'react';
import './LoadingPanel.css';

interface LoadingPanelProps {
  show: boolean;
}

/**
 * The in-flight load, drawn IN the content area rather than over the viewport.
 * It used to be a fixed full-screen overlay, which meant a load locked the page:
 * the location search and the date picker sat under it and ate every click, so
 * the only way to change your mind was to wait the load out. The controls live
 * in the pinned bar above this panel and stay clickable throughout — picking a
 * different date or location supersedes the load in flight (AppContext).
 */
const LoadingPanel: React.FC<LoadingPanelProps> = ({ show }) => {
  if (!show) return null;

  return (
    <div className="loading-panel" role="status" aria-live="polite">
      <div className="loading-content">
        <div className="loading-spinner"></div>
        <div className="loading-text">Loading weather data...</div>
      </div>
    </div>
  );
};

export default LoadingPanel;
