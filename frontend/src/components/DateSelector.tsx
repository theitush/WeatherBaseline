import React from 'react';
import './DateSelector.css';

interface DateSelectorProps {
  currentDate: string;
  onChange: (date: string) => void;
}

const DateSelector: React.FC<DateSelectorProps> = ({ currentDate, onChange }) => {
  return (
    <div className="date-selector">
      <label htmlFor="target-date">Date:</label>
      <input
        type="date"
        id="target-date"
        value={currentDate}
        onChange={(e) => onChange(e.target.value)}
        max={new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
      />
    </div>
  );
};

export default DateSelector;
