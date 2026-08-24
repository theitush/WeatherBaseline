"""Tests for the merge base that protects an archive's history on a top-up run.

`write_archive` merges a freshly-fetched span onto the cell's CURRENT R2 archive
and uploads the result. That is safe for a full-history run (1950->now): the span
it holds IS the whole archive, so a base it could not read costs nothing. It is
NOT safe for a partial-history run — `--year 2026`, the monthly top-up — where a
"write fresh" would replace 76 years in R2 with the handful of months just
fetched. `require_base` makes that case skip the cell instead.

Offline: a fake uploader stands in for R2, so nothing here touches the network.

Run:
  source .venv/bin/activate
  pytest test_merge_base.py -v
"""
from __future__ import annotations

import gzip
import io
from datetime import date

import pandas as pd
import pytest

import download_cells as dc
from download_cells import MergeBaseUnavailable, archive_name, write_archive


# --------------------------------------------------------------------------- #
# Helpers: a fake R2 uploader and small archive frames.
# --------------------------------------------------------------------------- #
class FakeUploader:
    """Stands in for R2Uploader. `get_bytes` is scripted per call."""

    bucket = "fake-bucket"

    def __init__(self, responses):
        # responses: list of bytes | None | Exception, consumed per get_bytes call
        self.responses = list(responses)
        self.get_calls: list[str] = []
        self.uploaded: list[tuple[str, str]] = []
        self.deleted: list[str] = []

    def get_bytes(self, key):
        self.get_calls.append(key)
        item = self.responses.pop(0) if self.responses else None
        if isinstance(item, Exception):
            raise item
        return item

    def upload_file(self, path, key):
        self.uploaded.append((str(path), key))

    def delete_object(self, key):
        self.deleted.append(key)


def frame(dates, tmax_start=20.0):
    """A minimal archive frame: the 4 shipped metrics over `dates`."""
    return pd.DataFrame({
        "date": [date.fromisoformat(d) for d in dates],
        "tmax_C": [tmax_start + i for i in range(len(dates))],
        "tmin_C": [tmax_start - 8 + i for i in range(len(dates))],
        "precip_mm": [0.0] * len(dates),
        "wind_max_ms": [3.0] * len(dates),
    })


def gz(df):
    """`df` as the gzip bytes an R2 archive object would hold."""
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as fh:
        fh.write(df.to_csv(index=False).encode())
    return buf.getvalue()


LAT, LON = 30.3, -97.7
HISTORY = ["1950-01-01", "2026-05-30", "2026-05-31"]
NEW_SPAN = ["2026-05-31", "2026-06-01", "2026-06-02"]


@pytest.fixture(autouse=True)
def isolate(tmp_path, monkeypatch):
    """Per-test archive dir, clean per-run seed set and skip list, no backoff."""
    monkeypatch.setattr(dc, "OUT_DIR", tmp_path / "archive")
    monkeypatch.setattr(dc, "_R2_SEEDED", set())
    monkeypatch.setattr(dc, "_SKIPPED_CELLS", [])
    monkeypatch.setattr(dc.time, "sleep", lambda _s: None)
    yield


def read_written(tmp_path):
    path = tmp_path / "archive" / archive_name(LAT, LON)
    return pd.read_csv(path) if path.exists() else None


# --------------------------------------------------------------------------- #
# The guard: a partial-history run must not overwrite what it cannot read.
# --------------------------------------------------------------------------- #
def test_partial_run_skips_the_cell_when_the_r2_base_cannot_be_read(tmp_path):
    up = FakeUploader([RuntimeError("500 Internal Error")] * dc._R2_BASE_RETRIES)
    with pytest.raises(MergeBaseUnavailable):
        write_archive(LAT, LON, frame(NEW_SPAN), uploader=up, require_base=True)
    # Nothing written locally => nothing to upload => R2 keeps its history.
    assert read_written(tmp_path) is None
    assert up.uploaded == []


def test_partial_run_skips_the_cell_when_the_r2_object_is_corrupt(tmp_path):
    up = FakeUploader([b"\x1f\x8b truncated garbage"])
    with pytest.raises(MergeBaseUnavailable):
        write_archive(LAT, LON, frame(NEW_SPAN), uploader=up, require_base=True)
    assert read_written(tmp_path) is None


def test_partial_run_retries_a_transient_read_then_merges(tmp_path):
    up = FakeUploader([
        RuntimeError("Connection reset by peer"),   # transient -> retried
        gz(frame(HISTORY)),
    ])
    write_archive(LAT, LON, frame(NEW_SPAN), uploader=up, require_base=True)
    out = read_written(tmp_path)
    assert len(up.get_calls) == 2
    assert list(out["date"]) == ["1950-01-01", "2026-05-30", "2026-05-31",
                                 "2026-06-01", "2026-06-02"]


def test_partial_run_gives_up_after_the_retry_budget(tmp_path):
    up = FakeUploader([RuntimeError("timeout")] * dc._R2_BASE_RETRIES)
    with pytest.raises(MergeBaseUnavailable):
        write_archive(LAT, LON, frame(NEW_SPAN), uploader=up, require_base=True)
    assert len(up.get_calls) == dc._R2_BASE_RETRIES


def test_partial_run_writes_fresh_when_r2_genuinely_has_no_object(tmp_path):
    """A 404 is not a hazard: there is no history to lose."""
    up = FakeUploader([None])
    write_archive(LAT, LON, frame(NEW_SPAN), uploader=up, require_base=True)
    out = read_written(tmp_path)
    assert list(out["date"]) == NEW_SPAN


# --------------------------------------------------------------------------- #
# Full-history runs keep the old best-effort behaviour.
# --------------------------------------------------------------------------- #
def test_full_history_run_still_degrades_to_a_fresh_write(tmp_path):
    up = FakeUploader([RuntimeError("500 Internal Error")])
    write_archive(LAT, LON, frame(NEW_SPAN), uploader=up)  # require_base=False
    out = read_written(tmp_path)
    assert list(out["date"]) == NEW_SPAN


# --------------------------------------------------------------------------- #
# The merge itself: history kept, shared dates last-wins.
# --------------------------------------------------------------------------- #
def test_merge_keeps_history_and_lets_the_new_span_win_shared_dates(tmp_path):
    base = frame(HISTORY, tmax_start=10.0)
    up = FakeUploader([gz(base)])
    write_archive(LAT, LON, frame(NEW_SPAN, tmax_start=30.0), uploader=up,
                  require_base=True)
    out = read_written(tmp_path)
    assert len(out) == 5
    # 2026-05-31 is in both; the freshly fetched value must win.
    shared = out.loc[out["date"] == "2026-05-31", "tmax_C"].iloc[0]
    assert shared == 30.0
    # ...and the years the span never touched are still there.
    assert out.loc[out["date"] == "1950-01-01", "tmax_C"].iloc[0] == 10.0


def test_the_r2_base_is_read_once_per_cell_per_run(tmp_path):
    """Second span of the same cell merges onto the local file, not a new GET."""
    up = FakeUploader([gz(frame(HISTORY))])
    write_archive(LAT, LON, frame(["2026-06-01"]), uploader=up, require_base=True)
    write_archive(LAT, LON, frame(["2026-06-02"]), uploader=up, require_base=True)
    assert len(up.get_calls) == 1
    out = read_written(tmp_path)
    assert list(out["date"])[-2:] == ["2026-06-01", "2026-06-02"]


# --------------------------------------------------------------------------- #
# run_tile records the skip instead of failing the whole tile.
# --------------------------------------------------------------------------- #
def test_run_tile_records_the_skip_and_uploads_nothing(monkeypatch, tmp_path):
    up = FakeUploader([RuntimeError("503 Slow Down")] * dc._R2_BASE_RETRIES)
    cells = [{"lat": LAT, "lon": LON, "tile_id": "11_26"}]
    monkeypatch.setattr(dc, "missing_years", lambda *a, **k: [2026])
    monkeypatch.setattr(dc, "process_span",
                        lambda *a, **k: {(LAT, LON): frame(NEW_SPAN)})

    written = dc.run_tile(None, "11_26", cells, [2026], 20, 4, True,
                          latest_date=date(2026, 8, 15), uploader=up,
                          require_base=True)

    assert written == 0
    assert dc._SKIPPED_CELLS == [archive_name(LAT, LON)]
    assert up.uploaded == [] and up.deleted == []
    assert read_written(tmp_path) is None


# --------------------------------------------------------------------------- #
# Retrying what R2 actually throws (seen live 2026-08-25).
# --------------------------------------------------------------------------- #
R2_INTERNAL = ("An error occurred (InternalError) when calling the GetObject "
               "operation (reached max retries: 4): We encountered an internal "
               "error. Please try again.")


def test_an_r2_internal_error_is_retried_not_skipped(tmp_path):
    """The burst that skipped 7 cells mid-run: boto3 gives up, we back off."""
    up = FakeUploader([RuntimeError(R2_INTERNAL), gz(frame(HISTORY))])
    write_archive(LAT, LON, frame(NEW_SPAN), uploader=up, require_base=True)
    assert len(up.get_calls) == 2
    assert read_written(tmp_path) is not None


def test_a_required_base_retries_even_an_unrecognised_error(tmp_path):
    """Skipping the cell is the fallback, so a wasted retry is the cheap side."""
    up = FakeUploader([RuntimeError("something new"), gz(frame(HISTORY))])
    write_archive(LAT, LON, frame(NEW_SPAN), uploader=up, require_base=True)
    assert len(up.get_calls) == 2


def test_a_best_effort_base_does_not_retry_an_unrecognised_error(tmp_path):
    """Full-history run: nothing to lose, so don't spend retries on it."""
    up = FakeUploader([RuntimeError("something new"), gz(frame(HISTORY))])
    write_archive(LAT, LON, frame(NEW_SPAN), uploader=up)
    assert len(up.get_calls) == 1
    assert list(read_written(tmp_path)["date"]) == NEW_SPAN


def test_the_skip_message_carries_r2_request_ids(tmp_path):
    """What a support ticket needs: status + request id, not just a stack type."""
    err = RuntimeError(R2_INTERNAL)
    err.response = {"ResponseMetadata": {"HTTPStatusCode": 500,
                                         "RequestId": "abc123",
                                         "HostId": "host9"}}
    up = FakeUploader([err] * dc._R2_BASE_RETRIES)
    with pytest.raises(MergeBaseUnavailable) as caught:
        write_archive(LAT, LON, frame(NEW_SPAN), uploader=up, require_base=True)
    msg = str(caught.value)
    assert "HTTPStatusCode=500" in msg and "RequestId=abc123" in msg
