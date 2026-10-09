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

# One QuickTest runner executes every tests/qml/tst_*.qml file.
qt_add_executable(tst_qml qml/tst_qml.cpp qml/TestHarness.h qml/TestHarness.cpp)
target_include_directories(tst_qml PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/support ${CMAKE_CURRENT_SOURCE_DIR}/qml)
target_link_libraries(tst_qml PRIVATE jarvis_installer_core jarvis_installer_coreplugin Qt6::QuickTest)
target_compile_definitions(tst_qml PRIVATE
  QUICK_TEST_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/qml"
  JARVIS_TEST_I18N_DIR="${JARVIS_I18N_BUILD_DIR}"
  JARVIS_QML_DIR="${QT_QML_OUTPUT_DIRECTORY}"
  JARVIS_INSTALLER_TEST_DATA="${JARVIS_INSTALLER_TEST_DATA}"
  JARVIS_TEST_OS_RELEASE="${CMAKE_CURRENT_SOURCE_DIR}/data/os-release")
add_dependencies(tst_qml jarvis_ui jarvis-ui_translations jarvis-installer_translations)
add_test(NAME tst_qml COMMAND tst_qml)
set_tests_properties(tst_qml PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS qml TIMEOUT 180)

# The real binary starts, loads its QML against the fake backend, and quits.
add_test(NAME installer_smoke
  COMMAND $<TARGET_FILE:jarvis-installer> --windowed --quit-after 1500
          --fake-backend ${CMAKE_CURRENT_SOURCE_DIR}/../data/demo.json)
set_tests_properties(installer_smoke PROPERTIES LABELS smoke TIMEOUT 30
  ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QML_IMPORT_PATH=${QT_QML_OUTPUT_DIRECTORY};JARVIS_OS_RELEASE=${CMAKE_CURRENT_SOURCE_DIR}/data/os-release"
  FAIL_REGULAR_EXPRESSION "is not installed|is not a type|ReferenceError|TypeError")
