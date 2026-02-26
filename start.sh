#!/bin/bash
# Load .env if exists (safe — no word-splitting, handles special chars)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

PORT=${PORT:-8780}
exec gunicorn server:app \
  --bind 0.0.0.0:${PORT} \
  --workers 2 \
  --timeout 120 \
  --access-logfile - \
  --error-logfile -
