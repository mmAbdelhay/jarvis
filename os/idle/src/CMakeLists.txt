add_library(jarvis_idle_core STATIC
  core/IdlePolicy.h core/IdlePolicy.cpp core/IdleConfig.h core/IdleConfig.cpp core/LockLauncher.h core/LockLauncher.cpp)
target_include_directories(jarvis_idle_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(jarvis_idle_core PUBLIC Qt6::Core)
if(JARVIS_IDLE_LINUX)
  find_package(Qt6 6.8 REQUIRED COMPONENTS DBus)
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(WAYLAND_CLIENT REQUIRED IMPORTED_TARGET wayland-client)
  pkg_get_variable(WAYLAND_PROTOCOLS_DIR wayland-protocols pkgdatadir)
  find_program(WAYLAND_SCANNER wayland-scanner REQUIRED)
  set(JARVIS_IDLE_XML ${WAYLAND_PROTOCOLS_DIR}/staging/ext-idle-notify/ext-idle-notify-v1.xml)
  set(JARVIS_IDLE_GEN ${CMAKE_CURRENT_BINARY_DIR}/protocol)
  file(MAKE_DIRECTORY ${JARVIS_IDLE_GEN})
  add_custom_command(
    OUTPUT ${JARVIS_IDLE_GEN}/ext-idle-notify-v1-client-protocol.h ${JARVIS_IDLE_GEN}/ext-idle-notify-v1-protocol.c
    COMMAND ${WAYLAND_SCANNER} client-header ${JARVIS_IDLE_XML} ${JARVIS_IDLE_GEN}/ext-idle-notify-v1-client-protocol.h
    COMMAND ${WAYLAND_SCANNER} private-code ${JARVIS_IDLE_XML} ${JARVIS_IDLE_GEN}/ext-idle-notify-v1-protocol.c
    DEPENDS ${JARVIS_IDLE_XML} VERBATIM)
  add_library(jarvis_idle_linux STATIC
    linux/IdleNotifier.h linux/IdleNotifier.cpp linux/LogindWatcher.h linux/LogindWatcher.cpp
    ${JARVIS_IDLE_GEN}/ext-idle-notify-v1-client-protocol.h ${JARVIS_IDLE_GEN}/ext-idle-notify-v1-protocol.c)
  target_include_directories(jarvis_idle_linux PUBLIC ${CMAKE_CURRENT_SOURCE_DIR} ${JARVIS_IDLE_GEN})
  target_link_libraries(jarvis_idle_linux PUBLIC jarvis_idle_core Qt6::DBus PkgConfig::WAYLAND_CLIENT)

  function(jarvis_idle_executable name)
    qt_add_executable(${name} main.cpp)
    target_link_libraries(${name} PRIVATE jarvis_idle_linux)
    target_compile_definitions(${name} PRIVATE JARVIS_IDLE_VERSION="${PROJECT_VERSION}")
  endfunction()
  jarvis_idle_executable(jarvis-idle)
  install(TARGETS jarvis-idle RUNTIME DESTINATION ${CMAKE_INSTALL_LIBEXECDIR}/jarvis)
  install(FILES ${CMAKE_CURRENT_SOURCE_DIR}/../data/autostart DESTINATION ${CMAKE_INSTALL_DATADIR}/jarvis-idle/labwc)
  # CI only, never installed (ci/test.sh proves it).
  jarvis_idle_executable(jarvis-idle-testhooks)
  target_compile_definitions(jarvis-idle-testhooks PRIVATE JARVIS_IDLE_TEST_HOOKS=1)
endif()
