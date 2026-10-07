# Sources and QML files are globbed so parallel tasks never edit this file.
file(GLOB_RECURSE JARVIS_SHELL_CPP CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR}
  protocol/*.cpp protocol/*.h control/*.cpp control/*.h
  models/*.cpp models/*.h app/*.cpp app/*.h)
file(GLOB JARVIS_SHELL_QML CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR} qml/*.qml)

# Every QML file lives at the module root (next to the generated qmldir), so the
# singletons and the C++ types of Jarvis.Shell resolve in all of them.
foreach(qml_file IN LISTS JARVIS_SHELL_QML)
  get_filename_component(qml_name ${qml_file} NAME)
  set_source_files_properties(${qml_file} PROPERTIES QT_RESOURCE_ALIAS ${qml_name})
endforeach()
set_source_files_properties(qml/Theme.qml qml/Icons.qml PROPERTIES QT_QML_SINGLETON_TYPE TRUE)

qt_add_library(jarvis_shell_core STATIC)
qt_add_qml_module(jarvis_shell_core
  URI Jarvis.Shell
  VERSION 1.0
  CLASS_NAME JarvisShellPlugin
  PLUGIN_TARGET jarvis_shell_coreplugin
  SOURCES ${JARVIS_SHELL_CPP}
  QML_FILES ${JARVIS_SHELL_QML}
)
target_include_directories(jarvis_shell_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/models ${CMAKE_CURRENT_SOURCE_DIR}/app)
target_link_libraries(jarvis_shell_core PUBLIC
  Qt6::Core Qt6::Gui Qt6::Network Qt6::Qml Qt6::Quick Qt6::QuickControls2)
if(JARVIS_SHELL_LAYERSHELL)
  target_link_libraries(jarvis_shell_core PUBLIC LayerShellQt::Interface)
  target_compile_definitions(jarvis_shell_core PUBLIC JARVIS_HAVE_LAYERSHELL=1)
endif()

qt_add_executable(jarvis-shell main.cpp)
target_link_libraries(jarvis-shell PRIVATE jarvis_shell_core jarvis_shell_coreplugin)
target_compile_definitions(jarvis-shell PRIVATE JARVIS_SHELL_VERSION="${PROJECT_VERSION}")
install(TARGETS jarvis-shell RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
