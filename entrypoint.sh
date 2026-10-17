#!/bin/sh
set -eu
umask 0007
# Bounded validation under the actual runtime UID, before the application accepts traffic.
if ! timeout 25 "${GREENFLIX_FFPROBE_PATH:-/usr/local/bin/ffprobe}" -v error -show_program_version -show_entries program_version=version -of json >/dev/null 2>&1; then
  echo 'FFprobe startup validation failed. Check the configured executable and runtime permissions.' >&2
  exit 1
fi
if [ ! -d /data ] || [ ! -w /data ] || ! grep -q ' /data ' /proc/self/mountinfo; then
  echo 'SQLite storage /data must be mounted and writable.' >&2
  exit 1
fi
if [ "${GREENFLIX_DATABASE_URL:-}" != 'jdbc:sqlite:/data/greenflix.db' ]; then
  echo 'Container database must be /data/greenflix.db.' >&2
  exit 1
fi
exec java --enable-native-access=ALL-UNNAMED -XX:MaxRAMPercentage=65 -XX:+ExitOnOutOfMemoryError -Djava.io.tmpdir=/tmp -Dorg.sqlite.tmpdir=/tmp -jar /app/app.jar "$@"
