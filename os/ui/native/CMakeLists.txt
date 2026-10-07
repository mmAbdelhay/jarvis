add_library(jarvis_ui_native INTERFACE)
target_include_directories(jarvis_ui_native INTERFACE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(jarvis_ui_native INTERFACE Qt6::Core)

if(JARVIS_UI_DBUS)
  find_package(Qt6 6.8 REQUIRED COMPONENTS DBus)
  target_link_libraries(jarvis_ui_native INTERFACE Qt6::DBus)
  target_compile_definitions(jarvis_ui_native INTERFACE JARVIS_HAVE_DBUS=1)
endif()
