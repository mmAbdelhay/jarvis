cmake_minimum_required(VERSION 3.24)
project(jarvis-shell VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Qt6 6.8 REQUIRED COMPONENTS Core Gui Network Qml Quick QuickControls2)
qt_standard_project_setup(REQUIRES 6.8)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  set(_jarvis_layershell_default ON)
else()
  set(_jarvis_layershell_default OFF)
endif()
option(JARVIS_SHELL_LAYERSHELL "Put the shell on a wlr-layer-shell surface (LayerShellQt)" ${_jarvis_layershell_default})
if(JARVIS_SHELL_LAYERSHELL)
  find_package(LayerShellQt 6 REQUIRED)
endif()

include(GNUInstallDirs)
include(CTest)

# Shared look (contracts §7 jarvis-ui): build Jarvis.UI next to us so tests and
# qmlcachegen find it in <build>/qml; at runtime it comes from the jarvis-ui package.
set(QT_QML_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/qml)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../ui ${CMAKE_BINARY_DIR}/jarvis-ui EXCLUDE_FROM_ALL)

add_subdirectory(src)
if(BUILD_TESTING)
  find_package(Qt6 6.8 REQUIRED COMPONENTS Test QuickTest)
  add_subdirectory(tests)
endif()
