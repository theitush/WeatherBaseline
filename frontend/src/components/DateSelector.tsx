import React, { useEffect, useRef } from 'react';
import './DateSelector.css';

interface DateSelectorProps {
  currentDate: string;
  onChange: (date: string) => void;
}

const DateSelector: React.FC<DateSelectorProps> = ({ currentDate, onChange }) => {
  // Uncontrolled: the DOM owns the value while you pick. Paging month/year and
  // clicking a day both fire `change` with no way to tell them apart, so we
  // don't fetch on `change` at all — the user picks freely, then clicks Go to
  // commit. One fetch per intentional pick, no stray fetches while browsing.
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync external changes (e.g. a different city resets the date) into the DOM
  // input without making it controlled.
  useEffect(() => {
    if (inputRef.current && inputRef.current.value !== currentDate) {
      inputRef.current.value = currentDate;
    }
  }, [currentDate]);

  const commit = () => {
    const value = inputRef.current?.value;
    if (value && value !== currentDate) {
      onChange(value);
    }
  };

  return (
    <div className="date-selector">
      <input
        ref={inputRef}
        type="date"
        id="target-date"
        defaultValue={currentDate}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            if (inputRef.current) inputRef.current.value = currentDate;
            (e.target as HTMLInputElement).blur();
          }
        }}
        max={new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
      />
      <button type="button" className="date-go" onClick={commit}>
        Go
      </button>
    </div>
  );
};

export default DateSelector;
