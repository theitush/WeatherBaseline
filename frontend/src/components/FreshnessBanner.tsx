import React from 'react';
import './FreshnessBanner.css';

interface Props {
  onRefresh: () => void;
  onDismiss: () => void;
}

const FreshnessBanner: React.FC<Props> = ({ onRefresh, onDismiss }) => (
  <div className="freshness-banner" role="alert">
    <span className="freshness-banner__text">
      Couldn't connect to forecast server — recent data may be stale.{' '}
      <button className="freshness-banner__refresh" onClick={onRefresh}>
        Refresh to retry
      </button>
      .
    </span>
    <button
      className="freshness-banner__close"
      onClick={onDismiss}
      aria-label="Dismiss"
    >
      ✕
    </button>
  </div>
);

export default FreshnessBanner;
