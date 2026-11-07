#!/usr/bin/env bash
# Generate the two compiled cohort workbooks with the local venv.
# Example: ./generate.sh --seed 42
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

exec .venv/bin/python data_generator.py "$@"
