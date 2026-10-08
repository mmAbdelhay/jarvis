set(JARVIS_QML_DIR "${QT_QML_OUTPUT_DIRECTORY}")

qt_add_executable(tst_osrelease unit/tst_osrelease.cpp)
target_link_libraries(tst_osrelease PRIVATE jarvis_ui_native Qt6::Test)
add_test(NAME tst_osrelease COMMAND tst_osrelease)
set_tests_properties(tst_osrelease PROPERTIES LABELS unit)

qt_add_executable(tst_ui tst_ui.cpp)
target_link_libraries(tst_ui PRIVATE Qt6::Quick Qt6::QuickControls2 Qt6::QuickTest)
target_compile_definitions(tst_ui PRIVATE
  QUICK_TEST_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/qml"
  JARVIS_QML_DIR="${JARVIS_QML_DIR}"
  JARVIS_TEST_OS_RELEASE="${CMAKE_CURRENT_SOURCE_DIR}/data/os-release")
add_dependencies(tst_ui jarvis_ui)
add_test(NAME tst_ui COMMAND tst_ui)
set_tests_properties(tst_ui PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS qml TIMEOUT 120)

add_test(NAME qml_imports_listed
  COMMAND ${CMAKE_COMMAND} -DQML_DIR=${CMAKE_CURRENT_SOURCE_DIR}/../src/qml
          -DMAP=${CMAKE_CURRENT_SOURCE_DIR}/../deps/qml-runtime.txt -DSKIP=Jarvis.UI
          -P ${CMAKE_CURRENT_SOURCE_DIR}/../cmake/check_qml_imports.cmake)
set_tests_properties(qml_imports_listed PROPERTIES LABELS unit)

qt_add_executable(tst_native unit/tst_native.cpp)
target_link_libraries(tst_native PRIVATE jarvis_ui_native Qt6::Gui Qt6::Test)
add_test(NAME tst_native COMMAND tst_native)
set_tests_properties(tst_native PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS unit)

if(JARVIS_UI_DBUS)
  find_program(DBUS_RUN_SESSION dbus-run-session)
  if(DBUS_RUN_SESSION)
    qt_add_executable(tst_logindpower unit/tst_logindpower.cpp)
    target_link_libraries(tst_logindpower PRIVATE jarvis_ui_native Qt6::DBus Qt6::Test)
    add_test(NAME tst_logindpower COMMAND ${DBUS_RUN_SESSION} -- $<TARGET_FILE:tst_logindpower>)
    set_tests_properties(tst_logindpower PROPERTIES LABELS dbus TIMEOUT 60)
  else()
    message(WARNING "dbus-run-session not found: D-Bus tests are not built (install dbus-daemon)")
  endif()
endif()
