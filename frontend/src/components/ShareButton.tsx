import React, { useEffect, useRef, useState } from 'react';
import { convert, unitLabelBare } from '../utils/units';
import { useUnits } from '../hooks/useUnits';
import type { MetricKey } from '../utils/config';
import './ShareButton.css';

// Header button that shares the current view. The shareable URL is already the
// app's source of truth (urlState), so the button mostly reduces friction:
// - mobile / supporting browsers: native OS share sheet (navigator.share)
// - desktop: copy the SAME teaser+link to the clipboard, with a "Copied!" flash
//
// Both paths send one teaser string built here, so the hook is consistent
// wherever it's shared. The recipient's app still renders its own unfurl card
// from our meta tags; this text is what the SHARER sends (and the fallback that
// apps without rich previews show).
interface ShareButtonProps {
  /** Place name for the teaser, e.g. "Beijing". Empty until a cell resolves. */
  placeName: string;
  /** Raw (metric-unit) value for the current day, or null if absent. */
  temp: number | null;
  currentMetric: MetricKey;
  /** Current date, YYYY-MM-DD. */
  date: string;
}

const SHARE_TITLE = 'How extreme is this weather?';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2025-06-05" -> "Jun 5". Parsed as plain parts (no tz games).
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  if (!m || !d) return '';
  return `${MONTHS[m - 1]} ${d}`;
}

const ShareButton: React.FC<ShareButtonProps> = ({ placeName, temp, currentMetric, date }) => {
  const { system } = useUnits();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    []
  );

  const flashCopied = () => {
    setCopied(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1600);
  };

  // Build the teaser: "38.2°C in Beijing on Jun 5 — is it normal?".
  // Value + unit are formatted exactly as the display does (convert + bare
  // unit label), so the shared number matches what the sharer sees. Each part
  // is optional — drop gracefully to "How extreme is this weather? ..." if the
  // value or place hasn't resolved yet.
  const buildTeaser = (): string => {
    let valuePhrase = '';
    if (temp !== null && temp !== undefined) {
      const unit = unitLabelBare(currentMetric, system);
      const c = convert(temp, currentMetric, system);
      const shown = unit === '°' ? `${c.toFixed(1)}°` : `${c.toFixed(1)} ${unit}`;
      const where = placeName ? ` in ${placeName}` : '';
      const when = shortDate(date) ? ` on ${shortDate(date)}` : '';
      valuePhrase = `${shown}${where}${when}`;
    } else if (placeName) {
      valuePhrase = `the weather in ${placeName}`;
    }
    return valuePhrase
      ? `${valuePhrase} — is it normal?`
      : 'How extreme is this weather? Is it normal?';
  };

  const handleShare = async () => {
    const url = window.location.href;
    const text = buildTeaser();

    // Native share sheet where available (mostly mobile). A user-cancelled
    // sheet rejects with AbortError — ignore it, don't fall back to copy.
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: SHARE_TITLE, text, url });
        return;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        // Any other failure: fall through to clipboard.
      }
    }

    // Desktop: copy the same teaser + link as one block, so the hook travels
    // with the paste (Slack/Discord/email) just like the mobile share sheet.
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      flashCopied();
    } catch {
      // Clipboard blocked (e.g. insecure context): last-resort prompt.
      window.prompt('Copy this:', `${text} ${url}`);
    }
  };

  return (
    <div className="share-button">
      <button
        type="button"
        className="share-trigger"
        onClick={handleShare}
        aria-label="Share"
        title="Share"
      >
        {/* Feather "share-2" — three dots joined by lines. */}
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
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
      </button>

      {copied && (
        <span className="share-copied" role="status">
          Copied!
        </span>
      )}
    </div>
  );
};

export default ShareButton;
