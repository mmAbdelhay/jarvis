#!/bin/sh
# Stands in for jarvis-lock: says "locked", waits $2 seconds, exits with $1.
echo locked
sleep "${2:-0.2}"
exit "${1:-0}"
