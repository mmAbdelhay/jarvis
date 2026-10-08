# Sources are globbed so later tasks add files without editing this list.
file(GLOB_RECURSE JARVIS_CLASSIC_CPP CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR} model/*.cpp model/*.h)
file(GLOB JARVIS_CLASSIC_QML CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR} qml/*.qml)
foreach(qml_file IN LISTS JARVIS_CLASSIC_QML)
  get_filename_component(qml_name ${qml_file} NAME)
  set_source_files_properties(${qml_file} PROPERTIES QT_RESOURCE_ALIAS ${qml_name})
endforeach()

qt_add_library(jarvis_classic_core STATIC)
qt_add_qml_module(jarvis_classic_core
  URI Jarvis.Classic
  VERSION 1.0
  CLASS_NAME JarvisClassicPlugin
  PLUGIN_TARGET jarvis_classic_coreplugin
  SOURCES ${JARVIS_CLASSIC_CPP}
  QML_FILES ${JARVIS_CLASSIC_QML}
)
add_dependencies(jarvis_classic_core jarvis_ui)
target_include_directories(jarvis_classic_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/model)
target_link_libraries(jarvis_classic_core PUBLIC
  Qt6::Core Qt6::Gui Qt6::Network Qt6::Qml Qt6::Quick Qt6::QuickControls2 jarvis_ui_native)
target_link_libraries(jarvis_classic_core PUBLIC jarvis_shell_core)
add_dependencies(jarvis_classic_core jarvis_shell_core)

qt_add_executable(jarvis-classic main.cpp surface/ClassicSurfaces.h surface/ClassicSurfaces.cpp)
target_include_directories(jarvis-classic PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(jarvis-classic PRIVATE jarvis_classic_core jarvis_classic_coreplugin jarvis_shell_coreplugin)
target_compile_definitions(jarvis-classic PRIVATE JARVIS_CLASSIC_VERSION="${PROJECT_VERSION}")
if(JARVIS_CLASSIC_LAYERSHELL)
  find_package(LayerShellQt 6 REQUIRED)
  target_link_libraries(jarvis-classic PRIVATE LayerShellQt::Interface)
  target_compile_definitions(jarvis-classic PRIVATE JARVIS_CLASSIC_HAVE_LAYERSHELL=1)
endif()
install(TARGETS jarvis-classic RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(FILES ${CMAKE_CURRENT_SOURCE_DIR}/../data/labwc/autostart ${CMAKE_CURRENT_SOURCE_DIR}/../data/labwc/rc.xml
  DESTINATION ${CMAKE_INSTALL_DATADIR}/jarvis-classic/labwc)
