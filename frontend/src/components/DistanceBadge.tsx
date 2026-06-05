import React from 'react';
import './DistanceBadge.css';

interface DistanceBadgeProps {
  /** Distance from the searched place to the snapped cell, in km. */
  distanceKm?: number;
}

/**
 * Tiny colored read-out between the location and date controls: how far the
 * snapped ERA5-Land cell sits from the searched place. The grid is 0.1° (~11 km
 * spacing), so a snap within ~9 km is essentially on-grid (green); farther means
 * we had no nearby cell, so it shades amber then red.
 */
const DistanceBadge: React.FC<DistanceBadgeProps> = ({ distanceKm }) => {
  if (distanceKm == null) return null;

  const level = distanceKm <= 9 ? 'good' : distanceKm <= 20 ? 'warn' : 'bad';
  const km = distanceKm < 1 ? '<1' : Math.min(Math.round(distanceKm), 99);

  return (
    <span
      className={`distance-badge distance-badge-${level}`}
      title="distance to nearest data cell"
    >
      ({km}km)
    </span>
  );
};

export default DistanceBadge;
