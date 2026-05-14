import React from 'react';
import './DateSelector.css';

interface DateSelectorProps {
  currentDate: string;
  onChange: (date: string) => void;
}

const DateSelector: React.FC<DateSelectorProps> = ({ currentDate, onChange }) => {
  const inputRef = React.useRef<HTMLInputElement>(null);

  const openPicker = () => {
    const el = inputRef.current;
    if (el && typeof (el as any).showPicker === 'function') {
      try { (el as any).showPicker(); } catch {}
    } else {
      el?.focus();
      el?.click();
    }
  };

  return (
    <div className="date-selector" onClick={openPicker}>
      <label htmlFor="target-date">Date:</label>
      <input
        ref={inputRef}
        type="date"
        id="target-date"
        value={currentDate}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => { e.stopPropagation(); openPicker(); }}
        max={new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
      />
    </div>
  );
};

export default DateSelector;
