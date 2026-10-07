# Native helpers shared by the apps (linked statically; not part of the jarvis-ui package).
add_library(jarvis_ui_native STATIC
  JarvisFont.h JarvisFont.cpp OsRelease.h PowerActions.h FakePower.h)
set_target_properties(jarvis_ui_native PROPERTIES AUTOMOC ON POSITION_INDEPENDENT_CODE ON)
target_include_directories(jarvis_ui_native PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(jarvis_ui_native PUBLIC Qt6::Core Qt6::Gui)
if(JARVIS_UI_DBUS)
  find_package(Qt6 6.8 REQUIRED COMPONENTS DBus)
  target_sources(jarvis_ui_native PRIVATE LogindPower.h LogindPower.cpp)
  target_link_libraries(jarvis_ui_native PUBLIC Qt6::DBus)
  target_compile_definitions(jarvis_ui_native PUBLIC JARVIS_HAVE_DBUS=1)
endif()
