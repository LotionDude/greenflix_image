#!/bin/sh
set -eu
umask 0007
if [ ! -d /data ] || [ ! -w /data ] || ! grep -q ' /data ' /proc/self/mountinfo; then
  echo 'SQLite storage /data must be mounted and writable.' >&2
  exit 1
fi
if [ "${GREENFLIX_DATABASE_URL:-}" != 'jdbc:sqlite:/data/greenflix.db' ]; then
  echo 'Container database must be /data/greenflix.db.' >&2
  exit 1
fi
exec java --enable-native-access=ALL-UNNAMED -XX:MaxRAMPercentage=65 -Djava.io.tmpdir=/tmp -Dorg.sqlite.tmpdir=/tmp -jar /app/app.jar
