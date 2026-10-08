#!/bin/sh
# Stands in for pacat in tst_recorder: writes the PCM file named in $1 to
# stdout, then waits until it is stopped (SIGTERM) like a real recorder.
cat "$1"
trap 'exit 0' TERM INT
while :; do sleep 0.05; done
