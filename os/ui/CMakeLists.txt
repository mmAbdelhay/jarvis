cmake_minimum_required(VERSION 3.24)
project(jarvis-ui VERSION 0.2.0 LANGUAGES CXX)

# Built two ways: stand-alone (package jarvis-ui: install rules + tests) or
# add_subdirectory'd by os/shell, os/installer, os/greeter (module only, so
# their tests import it from <build>/qml; never installed by them).
find_package(Qt6 6.8 REQUIRED COMPONENTS Core Gui Qml Quick QuickControls2)
if(PROJECT_IS_TOP_LEVEL)
  set(CMAKE_CXX_STANDARD 20)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
  set(CMAKE_CXX_EXTENSIONS OFF)
  qt_standard_project_setup(REQUIRES 6.8)
  include(GNUInstallDirs)
  include(CTest)
endif()
if(NOT QT_QML_OUTPUT_DIRECTORY)
  set(QT_QML_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/qml)
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  set(_jarvis_ui_dbus_default ON)
else()
  set(_jarvis_ui_dbus_default OFF)
endif()
option(JARVIS_UI_DBUS "Build the D-Bus parts (logind power, installer backend client)" ${_jarvis_ui_dbus_default})

add_subdirectory(native)
add_subdirectory(src)

if(PROJECT_IS_TOP_LEVEL)
  # Contracts §7: /usr/lib/x86_64-linux-gnu/qt6/qml/Jarvis/UI/ with prefix /usr on Debian.
  set(JARVIS_UI_QML_INSTALL_DIR "${CMAKE_INSTALL_LIBDIR}/qt6/qml/Jarvis/UI" CACHE PATH "Install dir of Jarvis.UI")
  install(TARGETS jarvis_ui LIBRARY DESTINATION ${JARVIS_UI_QML_INSTALL_DIR})
  install(FILES ${QT_QML_OUTPUT_DIRECTORY}/Jarvis/UI/qmldir
                ${QT_QML_OUTPUT_DIRECTORY}/Jarvis/UI/jarvis_ui.qmltypes
          DESTINATION ${JARVIS_UI_QML_INSTALL_DIR})
  if(BUILD_TESTING)
    find_package(Qt6 6.8 REQUIRED COMPONENTS Test QuickTest)
    add_subdirectory(tests)
  endif()
endif()
