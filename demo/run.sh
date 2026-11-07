#!/usr/bin/env bash
# Run the matching demo with the local venv (installs deps if needed).
#
# Takes the two compiled workbooks, plus any match_demo.py flags:
#   ./run.sh generated_hosts.xlsx generated_students.xlsx
#   ./run.sh generated_hosts.xlsx generated_students.xlsx --solver compare-all
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

if [[ $# -lt 2 ]]; then
  echo "usage: ./run.sh HOSTS.xlsx STUDENTS.xlsx [match_demo.py flags…]" >&2
  exit 64
fi

hosts="$1"
students="$2"
shift 2

# If stdout is a TTY and bat is installed, pretty-print as Markdown automatically.
# Still works when you pipe yourself: ./run.sh h.xlsx s.xlsx | bat -l md
if [[ -t 1 ]] && command -v bat >/dev/null 2>&1; then
  exec .venv/bin/python match_demo.py --hosts "$hosts" --students "$students" "$@" \
    | bat --language=md --style=plain --paging=never
fi

exec .venv/bin/python match_demo.py --hosts "$hosts" --students "$students" "$@"
