cmake_minimum_required(VERSION 3.24)
project(jarvis-installer VERSION 0.2.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Qt6 6.8 REQUIRED COMPONENTS Core Gui Qml Quick QuickControls2)
qt_standard_project_setup(REQUIRES 6.8)
include(GNUInstallDirs)
include(CTest)

# Shared look (contracts §7 jarvis-ui), built into <build>/qml for tests; never installed from here.
set(QT_QML_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/qml)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../ui ${CMAKE_BINARY_DIR}/jarvis-ui EXCLUDE_FROM_ALL)
if(JARVIS_UI_DBUS)
  find_package(Qt6 6.8 REQUIRED COMPONENTS DBus)
endif()

add_subdirectory(src)
if(BUILD_TESTING)
  find_package(Qt6 6.8 REQUIRED COMPONENTS Test QuickTest)
  add_subdirectory(tests)
endif()
