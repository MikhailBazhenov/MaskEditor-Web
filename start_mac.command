#!/bin/bash
set -e
cd "$(dirname "$0")"
if [ ! -x ".venv/bin/python" ]; then
  python3 -m venv .venv
fi
".venv/bin/python" -m pip install -r requirements.txt
DATA="${1:-$(pwd)/sample_data}"
".venv/bin/python" server.py --data "$DATA"
