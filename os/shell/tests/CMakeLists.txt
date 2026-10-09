set(JARVIS_VECTORS_PATH "${CMAKE_CURRENT_SOURCE_DIR}/vectors/control-vectors.json")
file(GLOB JARVIS_TEST_SUPPORT CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/support/*.cpp)

function(jarvis_add_cpp_test source label timeout)
  get_filename_component(test_name ${source} NAME_WE)
  qt_add_executable(${test_name} ${source} ${JARVIS_TEST_SUPPORT})
  target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/support)
  target_compile_definitions(${test_name} PRIVATE JARVIS_VECTORS_PATH="${JARVIS_VECTORS_PATH}")
  target_compile_definitions(${test_name} PRIVATE JARVIS_TEST_I18N_DIR="${JARVIS_I18N_BUILD_DIR}")
  add_dependencies(${test_name} jarvis-ui_translations jarvis-shell_translations)
  target_link_libraries(${test_name} PRIVATE jarvis_shell_core Qt6::Test)
  add_test(NAME ${test_name} COMMAND ${test_name})
  set_tests_properties(${test_name} PROPERTIES
    ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS ${label} TIMEOUT ${timeout})
endfunction()

file(GLOB JARVIS_UNIT_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/unit/tst_*.cpp)
foreach(source IN LISTS JARVIS_UNIT_TESTS)
  jarvis_add_cpp_test(${source} unit 60)
endforeach()

# The overlay manager loads Jarvis.Shell QML: link the plugin and find Jarvis.UI.
target_link_libraries(tst_cuoverlaymanager PRIVATE jarvis_shell_coreplugin)
target_compile_definitions(tst_cuoverlaymanager PRIVATE JARVIS_QML_DIR="${QT_QML_OUTPUT_DIRECTORY}")
add_dependencies(tst_cuoverlaymanager jarvis_ui)

file(GLOB JARVIS_INTEGRATION_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/integration/tst_*.cpp)
foreach(source IN LISTS JARVIS_INTEGRATION_TESTS)
  jarvis_add_cpp_test(${source} integration 180)
endforeach()

# One QuickTest runner executes every tests/qml/tst_*.qml file.
qt_add_executable(tst_qml qml/tst_qml.cpp)
target_link_libraries(tst_qml PRIVATE jarvis_shell_core jarvis_shell_coreplugin Qt6::QuickTest)
target_compile_definitions(tst_qml PRIVATE QUICK_TEST_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/qml" JARVIS_QML_DIR="${QT_QML_OUTPUT_DIRECTORY}" JARVIS_TEST_I18N_DIR="${JARVIS_I18N_BUILD_DIR}")
add_dependencies(tst_qml jarvis_ui jarvis-ui_translations jarvis-shell_translations)
add_test(NAME tst_qml COMMAND tst_qml)
set_tests_properties(tst_qml PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS qml TIMEOUT 120)

# The published runtime QML module list must cover every import (contracts §6.18).
add_test(NAME qml_imports_listed
  COMMAND ${CMAKE_COMMAND} -DQML_DIR=${CMAKE_CURRENT_SOURCE_DIR}/../src/qml
          -DMAP=${CMAKE_CURRENT_SOURCE_DIR}/../deps/qml-runtime.txt -DSKIP=Jarvis.Shell
          -P ${CMAKE_CURRENT_SOURCE_DIR}/../../ui/cmake/check_qml_imports.cmake)
set_tests_properties(qml_imports_listed PROPERTIES LABELS unit)

# Design §3.1: the channels the shell hard-codes match @jarvis/wire's list.
# (cmake -P reads only the -D options that come before it.)
set(JARVIS_CHANNEL_CHECK ${CMAKE_COMMAND} -DSRC_DIR=${CMAKE_CURRENT_SOURCE_DIR}/../src
    -DOTHER_CLIENTS=${CMAKE_CURRENT_SOURCE_DIR}/data/other-clients.txt)
set(JARVIS_CHANNEL_SCRIPT -P ${CMAKE_CURRENT_SOURCE_DIR}/check_control_channels.cmake)
add_test(NAME control_channels_match_wire
  COMMAND ${JARVIS_CHANNEL_CHECK} -DWIRE_JSON=${CMAKE_CURRENT_SOURCE_DIR}/../../../packages/wire/os-control.json
          ${JARVIS_CHANNEL_SCRIPT})
set_tests_properties(control_channels_match_wire PROPERTIES LABELS unit)
# ...and the check really fails on drift (a renamed audit:list).
add_test(NAME control_channels_detect_drift
  COMMAND ${JARVIS_CHANNEL_CHECK} -DWIRE_JSON=${CMAKE_CURRENT_SOURCE_DIR}/data/os-control-drift.json
          ${JARVIS_CHANNEL_SCRIPT})
set_tests_properties(control_channels_detect_drift PROPERTIES LABELS unit WILL_FAIL TRUE)

# The labwc relaunch loop: backoff and exit when the Wayland socket is gone.
if(UNIX)
  add_test(NAME relaunch_loop
    COMMAND sh ${CMAKE_CURRENT_SOURCE_DIR}/data/test_relaunch_loop.sh
               ${CMAKE_CURRENT_SOURCE_DIR}/../data/jarvis-shell-loop)
  set_tests_properties(relaunch_loop PROPERTIES LABELS unit TIMEOUT 30)
endif()

# M3 contracts §5.15: Super+Space runs `jarvis-shell --voice` (the session's rc.xml).
add_test(NAME cli_has_voice_option COMMAND jarvis-shell --help)
set_tests_properties(cli_has_voice_option PROPERTIES
  ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS unit PASS_REGULAR_EXPRESSION "--voice")

# `jarvis-shell --settings` starts with no jarvisd, shows the window and quits.
add_test(NAME settings_window_smoke
  COMMAND $<TARGET_FILE:jarvis-shell> --settings --quit-after 1500)
set_tests_properties(settings_window_smoke PROPERTIES LABELS smoke TIMEOUT 30
  ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QML_IMPORT_PATH=${QT_QML_OUTPUT_DIRECTORY};XDG_RUNTIME_DIR=${CMAKE_CURRENT_BINARY_DIR}/settings-smoke;JARVIS_I18N_DIR=${JARVIS_I18N_BUILD_DIR}"
  FAIL_REGULAR_EXPRESSION "is not installed|is not a type|ReferenceError|TypeError|Cannot assign")
file(MAKE_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/settings-smoke)

# Rafiq v1.1 design §2.3 on a real compositor: the overlay on two headless
# labwc outputs, click-through outside the pill, outputs coming and going.
# Linux only; registered when every tool it drives is installed (CI checks it is).
if(JARVIS_SHELL_LAYERSHELL)
  find_program(JARVIS_LABWC labwc)
  find_program(JARVIS_GRIM grim)
  find_program(JARVIS_WLRCTL wlrctl)
  find_program(JARVIS_WLR_RANDR wlr-randr)
  if(JARVIS_LABWC AND JARVIS_GRIM AND JARVIS_WLRCTL AND JARVIS_WLR_RANDR)
    qt_add_executable(tst_overlay_wayland wayland/tst_overlay_wayland.cpp)
    target_link_libraries(tst_overlay_wayland PRIVATE jarvis_shell_core jarvis_shell_coreplugin Qt6::Test)
    target_compile_definitions(tst_overlay_wayland PRIVATE JARVIS_QML_DIR="${QT_QML_OUTPUT_DIRECTORY}")
    add_dependencies(tst_overlay_wayland jarvis_ui)
    add_test(NAME overlay_wayland
      COMMAND sh ${CMAKE_CURRENT_SOURCE_DIR}/wayland/run-headless-labwc.sh $<TARGET_FILE:tst_overlay_wayland>)
    set_tests_properties(overlay_wayland PROPERTIES LABELS wayland TIMEOUT 150)
  endif()
endif()
