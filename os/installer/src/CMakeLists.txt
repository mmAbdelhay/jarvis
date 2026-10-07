# Globbed so parallel tasks never edit this file.
file(GLOB_RECURSE JARVIS_INSTALLER_CPP CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR}
  backend/*.cpp backend/*.h model/*.cpp model/*.h)
if(NOT JARVIS_UI_DBUS)
  list(FILTER JARVIS_INSTALLER_CPP EXCLUDE REGEX "^backend/DBus")
endif()
file(GLOB JARVIS_INSTALLER_QML CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR} qml/*.qml)
foreach(qml_file IN LISTS JARVIS_INSTALLER_QML)
  get_filename_component(qml_name ${qml_file} NAME)
  set_source_files_properties(${qml_file} PROPERTIES QT_RESOURCE_ALIAS ${qml_name})
endforeach()

qt_add_library(jarvis_installer_core STATIC)
qt_add_qml_module(jarvis_installer_core
  URI Jarvis.Installer
  VERSION 1.0
  CLASS_NAME JarvisInstallerPlugin
  PLUGIN_TARGET jarvis_installer_coreplugin
  SOURCES ${JARVIS_INSTALLER_CPP}
  QML_FILES ${JARVIS_INSTALLER_QML}
)
# Re-run AUTOMOC when the initially empty scaffold gains backend/model files.
set_property(TARGET jarvis_installer_core APPEND PROPERTY
  AUTOGEN_TARGET_DEPENDS ${JARVIS_INSTALLER_CPP})
target_include_directories(jarvis_installer_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/backend ${CMAKE_CURRENT_SOURCE_DIR}/model)
target_link_libraries(jarvis_installer_core PUBLIC
  Qt6::Core Qt6::Gui Qt6::Qml Qt6::Quick Qt6::QuickControls2 jarvis_ui_native)
if(JARVIS_UI_DBUS)
  target_link_libraries(jarvis_installer_core PUBLIC Qt6::DBus)
endif()
add_dependencies(jarvis_installer_core jarvis_ui)
