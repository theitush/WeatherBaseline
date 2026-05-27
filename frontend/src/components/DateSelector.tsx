import React, { useEffect, useState } from 'react';
import './DateSelector.css';

interface DateSelectorProps {
  currentDate: string;
  onChange: (date: string) => void;
}

const DateSelector: React.FC<DateSelectorProps> = ({ currentDate, onChange }) => {
  const [pending, setPending] = useState(currentDate);

  useEffect(() => {
    setPending(currentDate);
  }, [currentDate]);

  const commit = () => {
    if (pending && pending !== currentDate) {
      onChange(pending);
    }
  };

  return (
    <div className="date-selector">
      <input
        type="date"
        id="target-date"
        value={pending}
        onChange={(e) => setPending(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            setPending(currentDate);
            (e.target as HTMLInputElement).blur();
          }
        }}
        max={new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
      />
    </div>
  );
};

export default DateSelector;
