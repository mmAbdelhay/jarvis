set(JARVIS_INSTALLER_TEST_DATA "${CMAKE_CURRENT_SOURCE_DIR}/data")
file(GLOB JARVIS_TEST_SUPPORT CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/support/*.cpp)

function(jarvis_add_cpp_test source label timeout)
  get_filename_component(test_name ${source} NAME_WE)
  qt_add_executable(${test_name} ${source} ${JARVIS_TEST_SUPPORT})
  target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/support)
  target_compile_definitions(${test_name} PRIVATE JARVIS_INSTALLER_TEST_DATA="${JARVIS_INSTALLER_TEST_DATA}")
  target_link_libraries(${test_name} PRIVATE jarvis_installer_core Qt6::Test)
  add_test(NAME ${test_name} COMMAND ${test_name})
  set_tests_properties(${test_name} PROPERTIES
    ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS ${label} TIMEOUT ${timeout})
endfunction()

file(GLOB JARVIS_UNIT_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/unit/tst_*.cpp)
foreach(source IN LISTS JARVIS_UNIT_TESTS)
  jarvis_add_cpp_test(${source} unit 60)
endforeach()

add_test(NAME qml_imports_listed
  COMMAND ${CMAKE_COMMAND} -DQML_DIR=${CMAKE_CURRENT_SOURCE_DIR}/../src/qml
          -DMAP=${CMAKE_CURRENT_SOURCE_DIR}/../deps/qml-runtime.txt -DSKIP=Jarvis.Installer
          -P ${CMAKE_CURRENT_SOURCE_DIR}/../../ui/cmake/check_qml_imports.cmake)
set_tests_properties(qml_imports_listed PROPERTIES LABELS unit)

if(JARVIS_UI_DBUS)
  find_program(DBUS_RUN_SESSION dbus-run-session)
  if(DBUS_RUN_SESSION)
    qt_add_executable(tst_dbusbackend dbus/tst_dbusbackend.cpp)
    target_link_libraries(tst_dbusbackend PRIVATE jarvis_installer_core Qt6::DBus Qt6::Test)
    set(JARVIS_DBUS_SESSION_ARGS)
    if(APPLE)
      # Homebrew's session config expects launchd; this test needs a private bus.
      set(JARVIS_DBUS_TEST_CONFIG "${CMAKE_CURRENT_BINARY_DIR}/dbus-test.conf")
      file(WRITE "${JARVIS_DBUS_TEST_CONFIG}" "<busconfig>
  <type>session</type>
  <listen>unix:path=${CMAKE_BINARY_DIR}/dbus-test.sock</listen>
  <auth>EXTERNAL</auth>
  <policy context=\"default\">
    <allow send_destination=\"*\"/>
    <allow receive_sender=\"*\"/>
    <allow own=\"*\"/>
  </policy>
</busconfig>
")
      list(APPEND JARVIS_DBUS_SESSION_ARGS "--config-file=${JARVIS_DBUS_TEST_CONFIG}")
    endif()
    add_test(NAME tst_dbusbackend COMMAND ${DBUS_RUN_SESSION} ${JARVIS_DBUS_SESSION_ARGS} -- $<TARGET_FILE:tst_dbusbackend>)
    set_tests_properties(tst_dbusbackend PROPERTIES LABELS dbus TIMEOUT 60)
  else()
    message(WARNING "dbus-run-session not found: D-Bus tests are not built (install dbus-daemon)")
  endif()
endif()
