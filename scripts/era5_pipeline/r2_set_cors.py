"""Apply the CORS policy the frontend needs to read tier files from R2.

The data files are fetched cross-origin: the page is served from Pages / a
custom domain (or localhost in the deploy preview), but the .csv.gz files live on
the bucket's public r2.dev origin. Without a CORS policy R2 sends no
Access-Control-Allow-Origin header, so the browser blocks the response and
tieredData.ts sees every tier as empty ("No weather data received").

This grants GET/HEAD from our known frontend origins. Reads are public anyway;
CORS just tells the browser it's allowed to read the bytes from script.

Auth: same R2 S3 API token env vars as r2_upload.py (source r2.env first).

Usage (from scripts/era5_pipeline/):
  set -a; source r2.env; set +a
  python r2_set_cors.py                       # apply
  python r2_set_cors.py --show                # print current policy
  python r2_set_cors.py --origin https://weatherbaseline.pages.dev  # add more
"""
from __future__ import annotations

import argparse
import os

import boto3
from botocore.config import Config

# Frontend origins allowed to fetch the data files. Add the production origin(s)
# here (Pages URL, custom domain) as they come online. localhost covers the
# local deploy preview (backend serving dist/ on :3000, Vite on :5173).
DEFAULT_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    # Production Pages origin (hyphenated — matches the 'weather-baseline'
    # Pages project / its <name>.pages.dev URL). The no-hyphen variant is kept
    # in case the project is ever renamed; extra origins are harmless.
    "https://weather-baseline.pages.dev",
    "https://weatherbaseline.pages.dev",
]


def client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", region_name="auto"),
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Set R2 bucket CORS for the frontend.")
    ap.add_argument("--bucket", default=os.environ.get("R2_BUCKET", "weather-baseline"))
    ap.add_argument("--origin", action="append", default=[],
                    help="extra allowed origin (repeatable); added to the defaults")
    ap.add_argument("--show", action="store_true", help="print current CORS and exit")
    args = ap.parse_args()
    c = client()

    if args.show:
        try:
            print(c.get_bucket_cors(Bucket=args.bucket))
        except Exception as e:  # noqa: BLE001
            print("no CORS set:", getattr(e, "response", {}).get("Error", {}).get("Code", e))
        return 0

    origins = DEFAULT_ORIGINS + args.origin
    rule = {
        "AllowedOrigins": origins,
        "AllowedMethods": ["GET", "HEAD"],
        "AllowedHeaders": ["*"],
        # Let the browser read the headers tieredData / the picker rely on.
        "ExposeHeaders": ["Content-Length", "Content-Encoding", "Content-Type", "Last-Modified"],
        "MaxAgeSeconds": 3600,
    }
    c.put_bucket_cors(Bucket=args.bucket, CORSConfiguration={"CORSRules": [rule]})
    print(f"CORS applied to '{args.bucket}' for origins: {', '.join(origins)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
