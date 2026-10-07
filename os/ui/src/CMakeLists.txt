file(GLOB JARVIS_UI_QML CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR} qml/*.qml)
foreach(qml_file IN LISTS JARVIS_UI_QML)
  get_filename_component(qml_name ${qml_file} NAME)
  set_source_files_properties(${qml_file} PROPERTIES QT_RESOURCE_ALIAS ${qml_name})
endforeach()
set_source_files_properties(qml/Theme.qml qml/Icons.qml PROPERTIES QT_QML_SINGLETON_TYPE TRUE)

# Plugin-only module: the target does not exist yet and PLUGIN_TARGET equals
# it, so qt_add_qml_module creates jarvis_ui as the (MODULE) plugin itself.
qt_add_qml_module(jarvis_ui
  URI Jarvis.UI
  VERSION 1.0
  PLUGIN_TARGET jarvis_ui
  SOURCES Brand.h Brand.cpp
  QML_FILES ${JARVIS_UI_QML}
)
target_link_libraries(jarvis_ui PRIVATE Qt6::Core Qt6::Qml Qt6::Quick jarvis_ui_native)
