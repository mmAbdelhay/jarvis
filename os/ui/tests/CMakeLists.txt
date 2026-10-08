find_package(Qt6 6.8 REQUIRED COMPONENTS LinguistTools)
set(JARVIS_TEST_I18N_DIR ${CMAKE_CURRENT_BINARY_DIR}/i18n)
set(_demo_qms "")
foreach(lang en ar)
  add_custom_command(OUTPUT ${JARVIS_TEST_I18N_DIR}/demo_${lang}.qm
    COMMAND ${CMAKE_COMMAND} -E make_directory ${JARVIS_TEST_I18N_DIR}
    COMMAND $<TARGET_FILE:Qt6::lrelease> -silent ${CMAKE_CURRENT_SOURCE_DIR}/data/i18n/demo_${lang}.ts
            -qm ${JARVIS_TEST_I18N_DIR}/demo_${lang}.qm
    DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/data/i18n/demo_${lang}.ts VERBATIM)
  list(APPEND _demo_qms ${JARVIS_TEST_I18N_DIR}/demo_${lang}.qm)
endforeach()
# Stand-in for the real catalog until Task 4 (removed there).
add_custom_command(OUTPUT ${JARVIS_TEST_I18N_DIR}/jarvis-ui_ar.qm
  COMMAND ${CMAKE_COMMAND} -E copy ${JARVIS_TEST_I18N_DIR}/demo_ar.qm ${JARVIS_TEST_I18N_DIR}/jarvis-ui_ar.qm
  DEPENDS ${JARVIS_TEST_I18N_DIR}/demo_ar.qm VERBATIM)
list(APPEND _demo_qms ${JARVIS_TEST_I18N_DIR}/jarvis-ui_ar.qm)
add_custom_target(jarvis_ui_test_qms DEPENDS ${_demo_qms})

qt_add_executable(tst_language unit/tst_language.cpp)
target_link_libraries(tst_language PRIVATE jarvis_ui_native Qt6::Gui Qt6::Test)
target_compile_definitions(tst_language PRIVATE JARVIS_TEST_I18N_DIR="${JARVIS_TEST_I18N_DIR}")
add_dependencies(tst_language jarvis_ui_test_qms)
add_test(NAME tst_language COMMAND tst_language)
set_tests_properties(tst_language PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS unit)

set(JARVIS_QML_DIR "${QT_QML_OUTPUT_DIRECTORY}")

qt_add_executable(tst_osrelease unit/tst_osrelease.cpp)
target_link_libraries(tst_osrelease PRIVATE jarvis_ui_native Qt6::Test)
add_test(NAME tst_osrelease COMMAND tst_osrelease)
set_tests_properties(tst_osrelease PROPERTIES LABELS unit)

qt_add_executable(tst_ui tst_ui.cpp)
target_link_libraries(tst_ui PRIVATE jarvis_ui_native Qt6::Quick Qt6::QuickControls2 Qt6::QuickTest)
target_compile_definitions(tst_ui PRIVATE
  QUICK_TEST_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/qml"
  JARVIS_QML_DIR="${JARVIS_QML_DIR}"
  JARVIS_TEST_OS_RELEASE="${CMAKE_CURRENT_SOURCE_DIR}/data/os-release"
  JARVIS_TEST_I18N_DIR="${JARVIS_TEST_I18N_DIR}")
add_dependencies(tst_ui jarvis_ui jarvis_ui_test_qms)
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

find_package(Python3 3.9 REQUIRED COMPONENTS Interpreter)
add_test(NAME i18n_tools
  COMMAND ${Python3_EXECUTABLE} -m unittest discover -s ${CMAKE_CURRENT_SOURCE_DIR}/../i18n/tests -v)
set_tests_properties(i18n_tools PROPERTIES LABELS "unit;i18n" TIMEOUT 60)
