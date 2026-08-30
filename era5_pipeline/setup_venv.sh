#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
HERE="$(pwd)"
VENV="$HERE/.venv"

if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi

"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install -r requirements.txt

if [ ! -f "$HOME/.cdsapirc" ]; then
  if [ -f "$HERE/.cdsapirc" ]; then
    echo "Linking $HERE/.cdsapirc -> ~/.cdsapirc"
    ln -s "$HERE/.cdsapirc" "$HOME/.cdsapirc"
  else
    echo "WARNING: ~/.cdsapirc not found and era5_pipeline/.cdsapirc not found."
    echo "Create one with:"
    echo "  url: https://cds.climate.copernicus.eu/api"
    echo "  key: <your-CDS-key>"
  fi
fi

echo "Done. Activate with: source $VENV/bin/activate"
