import React from 'react';
import './LoadingOverlay.css';

interface LoadingOverlayProps {
  show: boolean;
}

const LoadingOverlay: React.FC<LoadingOverlayProps> = ({ show }) => {
  if (!show) return null;

  return (
    <div className="loading-overlay">
      <div className="loading-content">
        <div className="loading-spinner"></div>
        <div className="loading-text">Sounding the atmosphere</div>
      </div>
    </div>
  );
};

export default LoadingOverlay;
