# ctest: jarvis-classic never sends control requests itself. Everything goes
# through the shell's ShellController, so the shell's channel check, card
# gating and lock gating cover classic mode too.
# Usage: cmake -DSRC_DIR=<os/classic/src> -P check_no_direct_channels.cmake
cmake_minimum_required(VERSION 3.24)
file(GLOB_RECURSE sources "${SRC_DIR}/*.cpp" "${SRC_DIR}/*.h" "${SRC_DIR}/*.qml")
foreach(source IN LISTS sources)
  file(READ "${source}" text)
  if(text MATCHES "(invoke|request|upload)\\(u\"")
    message(FATAL_ERROR "${source} sends a control request directly; go through ShellController")
  endif()
endforeach()
message(STATUS "jarvis-classic talks to jarvisd only through ShellController")
