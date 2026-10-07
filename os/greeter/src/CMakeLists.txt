file(GLOB_RECURSE JARVIS_GREETER_CPP CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR}
  greetd/*.cpp greetd/*.h model/*.cpp model/*.h)
file(GLOB JARVIS_GREETER_QML CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR} qml/*.qml)
foreach(qml_file IN LISTS JARVIS_GREETER_QML)
  get_filename_component(qml_name ${qml_file} NAME)
  set_source_files_properties(${qml_file} PROPERTIES QT_RESOURCE_ALIAS ${qml_name})
endforeach()

qt_add_library(jarvis_greeter_core STATIC)
qt_add_qml_module(jarvis_greeter_core
  URI Jarvis.Greeter
  VERSION 1.0
  CLASS_NAME JarvisGreeterPlugin
  PLUGIN_TARGET jarvis_greeter_coreplugin
  SOURCES ${JARVIS_GREETER_CPP}
  QML_FILES ${JARVIS_GREETER_QML}
)
target_include_directories(jarvis_greeter_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/greetd ${CMAKE_CURRENT_SOURCE_DIR}/model)
target_link_libraries(jarvis_greeter_core PUBLIC
  Qt6::Core Qt6::Gui Qt6::Network Qt6::Qml Qt6::Quick Qt6::QuickControls2 jarvis_ui_native)
add_dependencies(jarvis_greeter_core jarvis_ui)
