# Sources are globbed so later tasks add files without editing this list.
file(GLOB JARVIS_LOCK_CPP CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR}
  model/*.cpp model/*.h report/*.cpp report/*.h app/*.cpp app/*.h auth/Authenticator.h auth/Wipe.h)
if(JARVIS_LOCK_PAM)
  list(APPEND JARVIS_LOCK_CPP auth/PamAuthenticator.h auth/PamAuthenticator.cpp)
endif()
file(GLOB JARVIS_LOCK_QML CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR} qml/*.qml)
foreach(qml_file IN LISTS JARVIS_LOCK_QML)
  get_filename_component(qml_name ${qml_file} NAME)
  set_source_files_properties(${qml_file} PROPERTIES QT_RESOURCE_ALIAS ${qml_name})
endforeach()

# jarvis-lock reports lock state over jarvisd's control socket with the
# shell's own client (M1 contracts §3; M3 contracts §3 sys:setLocked).
set(JARVIS_SHELL_SRC ${CMAKE_CURRENT_SOURCE_DIR}/../../shell/src)
add_library(jarvis_lock_control STATIC
  ${JARVIS_SHELL_SRC}/protocol/FrameCodec.cpp ${JARVIS_SHELL_SRC}/protocol/Handshake.cpp
  ${JARVIS_SHELL_SRC}/protocol/BuildId.cpp ${JARVIS_SHELL_SRC}/protocol/ControlPaths.cpp
  ${JARVIS_SHELL_SRC}/control/ControlClient.h ${JARVIS_SHELL_SRC}/control/ControlClient.cpp)
target_include_directories(jarvis_lock_control PUBLIC ${JARVIS_SHELL_SRC})
target_link_libraries(jarvis_lock_control PUBLIC Qt6::Core Qt6::Network)

qt_add_library(jarvis_lock_core STATIC)
qt_add_qml_module(jarvis_lock_core
  URI Jarvis.Lock
  VERSION 1.0
  CLASS_NAME JarvisLockPlugin
  PLUGIN_TARGET jarvis_lock_coreplugin
  SOURCES ${JARVIS_LOCK_CPP}
  QML_FILES ${JARVIS_LOCK_QML}
)
add_dependencies(jarvis_lock_core jarvis_ui) # qmlcachegen reads Jarvis.UI's qmltypes
# qmltyperegistrations includes headers by basename, so model/ is on the path too.
target_include_directories(jarvis_lock_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/model)
target_link_libraries(jarvis_lock_core PUBLIC
  Qt6::Core Qt6::Gui Qt6::Qml Qt6::Quick Qt6::QuickControls2 jarvis_lock_control)
if(JARVIS_LOCK_PAM)
  find_path(PAM_INCLUDE_DIR security/pam_appl.h REQUIRED)
  find_library(PAM_LIBRARY pam REQUIRED)
  target_include_directories(jarvis_lock_core PUBLIC ${PAM_INCLUDE_DIR})
  target_link_libraries(jarvis_lock_core PUBLIC ${PAM_LIBRARY})
  target_compile_definitions(jarvis_lock_core PUBLIC JARVIS_HAVE_PAM=1)
endif()

# PAM service (M3 contracts §3). With prefix /usr, GNUInstallDirs puts SYSCONFDIR at /etc.
install(FILES ${CMAKE_CURRENT_SOURCE_DIR}/../data/pam/jarvis-lock DESTINATION ${CMAKE_INSTALL_FULL_SYSCONFDIR}/pam.d)

if(JARVIS_LOCK_WAYLAND)
  find_package(Qt6 6.8 REQUIRED COMPONENTS WaylandClient)
  if(Qt6_VERSION VERSION_GREATER_EQUAL 6.9)
    find_package(Qt6 REQUIRED COMPONENTS WaylandClientPrivate GuiPrivate)
  endif()
  find_package(PkgConfig REQUIRED)
  pkg_get_variable(WAYLAND_PROTOCOLS_DIR wayland-protocols pkgdatadir)
  qt_add_library(jarvis_lock_wayland STATIC
    wayland/SessionLockIntegration.h wayland/SessionLockIntegration.cpp
    wayland/SessionLock.h wayland/SessionLock.cpp
    wayland/LockSurface.h wayland/LockSurface.cpp
    wayland/WaylandLockBackend.h wayland/WaylandLockBackend.cpp)
  qt6_generate_wayland_protocol_client_sources(jarvis_lock_wayland
    FILES ${WAYLAND_PROTOCOLS_DIR}/staging/ext-session-lock/ext-session-lock-v1.xml)
  target_include_directories(jarvis_lock_wayland PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
  target_link_libraries(jarvis_lock_wayland PUBLIC
    jarvis_lock_core Qt6::Quick Qt6::WaylandClient Qt6::WaylandClientPrivate Qt6::GuiPrivate)
endif()

function(jarvis_lock_executable name)
  qt_add_executable(${name} main.cpp)
  target_link_libraries(${name} PRIVATE jarvis_lock_core jarvis_lock_coreplugin jarvis_ui_native)
  target_compile_definitions(${name} PRIVATE JARVIS_LOCK_VERSION="${PROJECT_VERSION}")
  if(JARVIS_LOCK_WAYLAND)
    target_link_libraries(${name} PRIVATE jarvis_lock_wayland)
    target_compile_definitions(${name} PRIVATE JARVIS_HAVE_SESSION_LOCK=1)
  endif()
endfunction()

jarvis_lock_executable(jarvis-lock)
install(TARGETS jarvis-lock RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})

# CI only, never installed (ci/test.sh proves it): types passwords from a file.
jarvis_lock_executable(jarvis-lock-testhooks)
target_compile_definitions(jarvis-lock-testhooks PRIVATE JARVIS_LOCK_TEST_HOOKS=1)
