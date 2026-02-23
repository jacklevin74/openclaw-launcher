#!/bin/bash
# Load .env if exists
[ -f .env ] && export $(grep -v '^#' .env | xargs)

PORT=${PORT:-8780}
exec gunicorn server:app \
  --bind 0.0.0.0:${PORT} \
  --workers 2 \
  --timeout 120 \
  --access-logfile - \
  --error-logfile -
