# ctest (Rafiq M3 contracts §3): the control requests jarvis-lock sends must be
# exactly os/shell/tests/data/other-clients.txt — the shell's channel test adds
# that file to its own requests and compares the union with
# packages/wire/os-control.json.
# Usage: cmake -DSRC_DIR=<os/lock/src> -DLISTED=<other-clients.txt> -P check_lock_channels.cmake
cmake_minimum_required(VERSION 3.24)
file(GLOB_RECURSE sources "${SRC_DIR}/*.cpp" "${SRC_DIR}/*.h")
set(sent "")
foreach(source IN LISTS sources)
  file(READ "${source}" text)
  string(REGEX MATCHALL "(invoke|request|upload)\\(u\"[^\"]+\"" calls "${text}")
  foreach(call IN LISTS calls)
    string(REGEX REPLACE "^[a-z]+\\(u\"([^\"]+)\"$" "\\1" ch "${call}")
    list(APPEND sent "${ch}")
  endforeach()
endforeach()
file(STRINGS "${LISTED}" listed REGEX "^[a-z][a-zA-Z0-9:._-]*$")
list(REMOVE_DUPLICATES sent)
list(SORT sent)
list(SORT listed)
if(NOT sent STREQUAL listed)
  message(FATAL_ERROR "jarvis-lock sends [${sent}] but ${LISTED} lists [${listed}]")
endif()
message(STATUS "jarvis-lock sends exactly the channels other-clients.txt lists")
