cmake_minimum_required(VERSION 3.24)
project(jarvis-idle VERSION 0.3.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Qt6 6.8 REQUIRED COMPONENTS Core)
qt_standard_project_setup(REQUIRES 6.8)
include(GNUInstallDirs)
include(CTest)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  set(_jarvis_idle_linux ON)
else()
  set(_jarvis_idle_linux OFF)
endif()
option(JARVIS_IDLE_LINUX "Build the ext-idle-notify-v1 and logind adapters and the daemon" ${_jarvis_idle_linux})

add_subdirectory(src)
if(BUILD_TESTING)
  find_package(Qt6 6.8 REQUIRED COMPONENTS Test)
  add_subdirectory(tests)
endif()
