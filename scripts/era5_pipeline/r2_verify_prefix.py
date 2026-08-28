"""Prove an uploaded tier matches its local dir byte-for-byte — without downloading.

R2 (like S3) sets an object's ETag to the MD5 of its bytes for single-part
uploads, and r2_upload.py sends every tier file in one part (boto3 only goes
multipart above 8 MB; the largest debias table is ~0.4 MB). So one listing
plus local md5sums is a full-fidelity check: every local file present under
the prefix with the identical digest, and nothing extra on R2.

    set -a; source r2.env; set +a
    python r2_verify_prefix.py --dir ../bias_study/data --tiers debias-v9

Exit 0 only when the sets match exactly and every digest agrees.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

from r2_upload import R2Uploader, UPLOADABLE_TIERS


def local_digests(tier_dir: Path) -> dict[str, str]:
    """name -> md5 hex for every .csv.gz in the tier's local dir."""
    out = {}
    for path in sorted(tier_dir.glob("*.csv.gz")):
        out[path.name] = hashlib.md5(path.read_bytes()).hexdigest()
    return out


def remote_etags(uploader: R2Uploader, tier: str) -> dict[str, str]:
    """name -> ETag (quotes stripped) for every object under `tier/`."""
    out = {}
    paginator = uploader.client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=uploader.bucket, Prefix=f"{tier}/"):
        for obj in page.get("Contents", []):
            out[obj["Key"].split("/", 1)[1]] = obj["ETag"].strip('"')
    return out


def verify_tier(uploader: R2Uploader, data_dir: Path, tier: str) -> bool:
    local = local_digests(data_dir / tier)
    remote = remote_etags(uploader, tier)
    missing = sorted(set(local) - set(remote))
    extra = sorted(set(remote) - set(local))
    mismatch = sorted(n for n in local.keys() & remote.keys() if local[n] != remote[n])
    multipart = sorted(n for n, e in remote.items() if "-" in e)  # "md5-N" = multipart, not comparable
    print(f"{tier}/: local {len(local)}  remote {len(remote)}  "
          f"missing-on-R2 {len(missing)}  extra-on-R2 {len(extra)}  "
          f"digest-mismatch {len(mismatch)}  multipart-etags {len(multipart)}")
    for label, names in (("missing", missing), ("extra", extra),
                         ("mismatch", mismatch), ("multipart", multipart)):
        for name in names[:10]:
            print(f"  {label}: {name}")
        if len(names) > 10:
            print(f"  ... {len(names) - 10} more {label}")
    return not (missing or extra or mismatch or multipart)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dir", required=True, help="root containing <tier>/ dirs")
    ap.add_argument("--tiers", nargs="+", required=True, choices=UPLOADABLE_TIERS)
    ap.add_argument("--bucket", default=None, help="override R2_BUCKET")
    args = ap.parse_args()
    uploader = R2Uploader(bucket=args.bucket)
    ok = all([verify_tier(uploader, Path(args.dir).resolve(), t) for t in args.tiers])
    print("VERIFIED: every object matches its local file" if ok else "MISMATCH — do not ship")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
