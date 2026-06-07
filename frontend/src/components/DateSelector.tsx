import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DayPicker, Nav, type NavProps } from 'react-day-picker';
import 'react-day-picker/style.css';
import './DateSelector.css';

interface DateSelectorProps {
  currentDate: string;
  onChange: (date: string) => void;
}

// Horizon is a hard today+4, independent of what any cell currently has loaded.
// Every selectable day is backed by the ensure-fresh gate: picking a recent or
// forecast day triggers the backend to top up that cell's recent/forecast tier
// through today+4 before the read, so the picker must never gate on the loaded
// data (a not-yet-backfilled cell would otherwise wrongly cap at its archive
// end and block today/forecast dates — the bug this replaces). Days are local;
// +4 days from local "now" is the furthest the live forecast reaches.
const MAX_AHEAD_DAYS = 4;
// Bound the year dropdown at 1950.
const MIN_DATE = new Date(1950, 0, 1);

// Parse a YYYY-MM-DD string as a local date (avoid the UTC shift `new Date(str)`
// applies to bare date strings).
const parseISO = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

// Short month labels (Jan, Feb, …) for the caption dropdown, so a long name
// like "September" can't widen the month dropdown into the Today button.
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toISO = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const formatLabel = (iso: string): string => {
  const d = parseISO(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const DateSelector: React.FC<DateSelectorProps> = ({ currentDate, onChange }) => {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState<Date>(parseISO(currentDate));
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = parseISO(currentDate);

  // Hard cap: local today + MAX_AHEAD_DAYS, at local midnight so the whole day
  // is selectable (a time-of-day component would let `{ after }` clip it). Not
  // derived from any loaded cell — see MAX_AHEAD_DAYS.
  const maxAllowed = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + MAX_AHEAD_DAYS);
    return d;
  }, []);

  // Keep the visible month in sync when the date is reset externally (e.g. a
  // different city), and snap back to the selected month each time we open.
  useEffect(() => {
    setMonth(parseISO(currentDate));
  }, [currentDate]);

  // Dismiss the popover on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleSelect = (date: Date | undefined) => {
    if (!date) return;
    const iso = toISO(date);
    setOpen(false);
    if (iso !== currentDate) onChange(iso);
  };

  // Custom nav: a small "Today" button sits between the month/year dropdowns
  // and the prev/next arrows. We wrap the stock <Nav> so the arrows keep their
  // built-in disabled logic, labels and chevrons.
  const NavWithToday = useMemo(
    () => (props: NavProps) =>
      (
        <div className="rdp-nav-row">
          <button
            type="button"
            className="date-today"
            onClick={() => handleSelect(new Date())}
          >
            Today
          </button>
          <Nav {...props} />
        </div>
      ),
    [currentDate]
  );

  return (
    <div className="date-selector" ref={wrapRef}>
      <button
        type="button"
        className={`date-trigger${open ? ' open' : ''}`}
        onClick={() => {
          setMonth(parseISO(currentDate));
          setOpen((o) => !o);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span>{formatLabel(currentDate)}</span>
        <svg
          className="date-trigger-icon"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </button>

      {open && (
        <div className="date-popover" role="dialog">
          <DayPicker
            mode="single"
            selected={selected}
            month={month}
            onMonthChange={setMonth}
            onSelect={handleSelect}
            disabled={{ after: maxAllowed }}
            captionLayout="dropdown"
            startMonth={MIN_DATE}
            endMonth={maxAllowed}
            showOutsideDays
            formatters={{ formatMonthDropdown: (month) => SHORT_MONTHS[month.getMonth()] }}
            components={{ Nav: NavWithToday }}
          />
        </div>
      )}
    </div>
  );
};

export default DateSelector;
