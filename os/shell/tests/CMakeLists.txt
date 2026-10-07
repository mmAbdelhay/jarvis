set(JARVIS_VECTORS_PATH "${CMAKE_CURRENT_SOURCE_DIR}/vectors/control-vectors.json")
file(GLOB JARVIS_TEST_SUPPORT CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/support/*.cpp)

function(jarvis_add_cpp_test source label timeout)
  get_filename_component(test_name ${source} NAME_WE)
  qt_add_executable(${test_name} ${source} ${JARVIS_TEST_SUPPORT})
  target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/support)
  target_compile_definitions(${test_name} PRIVATE JARVIS_VECTORS_PATH="${JARVIS_VECTORS_PATH}")
  target_link_libraries(${test_name} PRIVATE jarvis_shell_core Qt6::Test)
  add_test(NAME ${test_name} COMMAND ${test_name})
  set_tests_properties(${test_name} PROPERTIES
    ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS ${label} TIMEOUT ${timeout})
endfunction()

file(GLOB JARVIS_UNIT_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/unit/tst_*.cpp)
foreach(source IN LISTS JARVIS_UNIT_TESTS)
  jarvis_add_cpp_test(${source} unit 60)
endforeach()

file(GLOB JARVIS_INTEGRATION_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/integration/tst_*.cpp)
foreach(source IN LISTS JARVIS_INTEGRATION_TESTS)
  jarvis_add_cpp_test(${source} integration 180)
endforeach()

# One QuickTest runner executes every tests/qml/tst_*.qml file.
qt_add_executable(tst_qml qml/tst_qml.cpp)
target_link_libraries(tst_qml PRIVATE jarvis_shell_core jarvis_shell_coreplugin Qt6::QuickTest)
target_compile_definitions(tst_qml PRIVATE QUICK_TEST_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/qml")
add_test(NAME tst_qml COMMAND tst_qml)
set_tests_properties(tst_qml PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS qml TIMEOUT 120)

# The published runtime QML module list must cover every import (contracts §6.18).
add_test(NAME qml_imports_listed
  COMMAND ${CMAKE_COMMAND} -DQML_DIR=${CMAKE_CURRENT_SOURCE_DIR}/../src/qml
          -DMAP=${CMAKE_CURRENT_SOURCE_DIR}/../deps/qml-runtime.txt
          -P ${CMAKE_CURRENT_SOURCE_DIR}/check_qml_imports.cmake)
set_tests_properties(qml_imports_listed PROPERTIES LABELS unit)

# The labwc relaunch loop: backoff and exit when the Wayland socket is gone.
if(UNIX)
  add_test(NAME relaunch_loop
    COMMAND sh ${CMAKE_CURRENT_SOURCE_DIR}/data/test_relaunch_loop.sh
               ${CMAKE_CURRENT_SOURCE_DIR}/../data/jarvis-shell-loop)
  set_tests_properties(relaunch_loop PROPERTIES LABELS unit TIMEOUT 30)
endif()
