cmake_minimum_required(VERSION 3.24)
project(jarvis-lock VERSION 0.3.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Qt6 6.8 REQUIRED COMPONENTS Core Gui Network Qml Quick QuickControls2)
qt_standard_project_setup(REQUIRES 6.8)
include(GNUInstallDirs)
include(CTest)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  set(_jarvis_lock_linux ON)
else()
  set(_jarvis_lock_linux OFF)
endif()
option(JARVIS_LOCK_PAM "Check passwords with PAM service jarvis-lock" ${_jarvis_lock_linux})
option(JARVIS_LOCK_WAYLAND "Build the ext-session-lock-v1 client (QtWaylandClient private API)" ${_jarvis_lock_linux})

# Shared look (M2 contracts §7 jarvis-ui), built next to us for tests; shipped by jarvis-ui.
set(QT_QML_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/qml)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../ui ${CMAKE_BINARY_DIR}/jarvis-ui EXCLUDE_FROM_ALL)

add_subdirectory(src)
if(BUILD_TESTING)
  find_package(Qt6 6.8 REQUIRED COMPONENTS Test QuickTest)
  add_subdirectory(tests)
endif()
