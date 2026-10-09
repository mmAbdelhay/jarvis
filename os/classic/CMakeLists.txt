cmake_minimum_required(VERSION 3.24)
project(jarvis-classic VERSION 0.4.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Qt6 6.8 REQUIRED COMPONENTS Core Gui Network Qml Quick QuickControls2)
qt_standard_project_setup(REQUIRES 6.8)
include(GNUInstallDirs)
include(CTest)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  set(_jarvis_classic_layershell ON)
else()
  set(_jarvis_classic_layershell OFF)
endif()
option(JARVIS_CLASSIC_LAYERSHELL "Put the taskbar and panels on wlr-layer-shell surfaces" ${_jarvis_classic_layershell})

# Shared look and i18n (M2 contracts §7 jarvis-ui; Rafiq M4 contracts §3).
set(QT_QML_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/qml)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../ui ${CMAKE_BINARY_DIR}/jarvis-ui EXCLUDE_FROM_ALL)
include(${CMAKE_CURRENT_SOURCE_DIR}/../ui/cmake/JarvisI18n.cmake)

# The docked chat panel is the shell's own ChatView + ShellController (cards,
# lock and voice gating stay in one place). Build the shell's core library only.
set(JARVIS_SHELL_CORE_ONLY ON)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../shell ${CMAKE_BINARY_DIR}/jarvis-shell EXCLUDE_FROM_ALL)

add_subdirectory(src)
jarvis_add_translations(jarvis-classic TS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/i18n TARGET jarvis_classic_core
  SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/src/model ${CMAKE_CURRENT_SOURCE_DIR}/src/qml
  LINT_QML ${CMAKE_CURRENT_SOURCE_DIR}/src/qml
  LINT_CPP ${CMAKE_CURRENT_SOURCE_DIR}/src/model
  INSTALL TESTS)
if(BUILD_TESTING)
  find_package(Qt6 6.8 REQUIRED COMPONENTS Test QuickTest)
  add_subdirectory(tests)
endif()
