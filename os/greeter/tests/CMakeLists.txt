set(JARVIS_GREETER_TEST_DATA "${CMAKE_CURRENT_SOURCE_DIR}/data")
file(GLOB JARVIS_TEST_SUPPORT CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/support/*.cpp)

function(jarvis_add_cpp_test source label timeout)
  get_filename_component(test_name ${source} NAME_WE)
  qt_add_executable(${test_name} ${source} ${JARVIS_TEST_SUPPORT})
  target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/support)
  target_compile_definitions(${test_name} PRIVATE JARVIS_GREETER_TEST_DATA="${JARVIS_GREETER_TEST_DATA}")
  target_link_libraries(${test_name} PRIVATE jarvis_greeter_core Qt6::Test)
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
          -DMAP=${CMAKE_CURRENT_SOURCE_DIR}/../deps/qml-runtime.txt -DSKIP=Jarvis.Greeter
          -P ${CMAKE_CURRENT_SOURCE_DIR}/../../ui/cmake/check_qml_imports.cmake)
set_tests_properties(qml_imports_listed PROPERTIES LABELS unit)

qt_add_executable(tst_qml qml/tst_qml.cpp qml/GreeterHarness.h qml/GreeterHarness.cpp ${JARVIS_TEST_SUPPORT})
target_include_directories(tst_qml PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/support ${CMAKE_CURRENT_SOURCE_DIR}/qml)
target_link_libraries(tst_qml PRIVATE jarvis_greeter_core jarvis_greeter_coreplugin Qt6::QuickTest)
target_compile_definitions(tst_qml PRIVATE
  JARVIS_TEST_I18N_DIR="${CMAKE_BINARY_DIR}/i18n"
  QUICK_TEST_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/qml"
  JARVIS_QML_DIR="${QT_QML_OUTPUT_DIRECTORY}"
  JARVIS_GREETER_TEST_DATA="${JARVIS_GREETER_TEST_DATA}")
add_dependencies(tst_qml jarvis_ui jarvis-ui_translations jarvis-greeter_translations)
add_test(NAME tst_qml COMMAND tst_qml)
set_tests_properties(tst_qml PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS qml TIMEOUT 120)

# The real binary starts with no greetd and no model state, shows the screen, and quits.
add_test(NAME greeter_smoke COMMAND $<TARGET_FILE:jarvis-greeter> --windowed --quit-after 1500 --socket /tmp/no-greetd.sock)
set_tests_properties(greeter_smoke PROPERTIES LABELS smoke TIMEOUT 30
  ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QML_IMPORT_PATH=${QT_QML_OUTPUT_DIRECTORY};JARVIS_MODEL_STATE=/nonexistent/state.json"
  FAIL_REGULAR_EXPRESSION "is not installed|is not a type|ReferenceError|TypeError")
