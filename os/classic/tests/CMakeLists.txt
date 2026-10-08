set(JARVIS_CLASSIC_TEST_DATA "${CMAKE_CURRENT_SOURCE_DIR}/data")
file(GLOB JARVIS_CLASSIC_UNIT_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/unit/tst_*.cpp)
foreach(source IN LISTS JARVIS_CLASSIC_UNIT_TESTS)
  get_filename_component(test_name ${source} NAME_WE)
  qt_add_executable(${test_name} ${source})
  target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/support)
  target_compile_definitions(${test_name} PRIVATE JARVIS_CLASSIC_TEST_DATA="${JARVIS_CLASSIC_TEST_DATA}")
  target_link_libraries(${test_name} PRIVATE jarvis_classic_core Qt6::Test)
  add_test(NAME ${test_name} COMMAND ${test_name})
  set_tests_properties(${test_name} PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS unit TIMEOUT 60)
endforeach()

qt_add_executable(tst_qml qml/tst_qml.cpp)
target_link_libraries(tst_qml PRIVATE jarvis_classic_core jarvis_classic_coreplugin jarvis_shell_coreplugin Qt6::QuickTest)
target_compile_definitions(tst_qml PRIVATE
  QUICK_TEST_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/qml"
  JARVIS_QML_DIR="${QT_QML_OUTPUT_DIRECTORY}"
  JARVIS_TEST_I18N_DIR="${JARVIS_I18N_BUILD_DIR}"
  JARVIS_CLASSIC_TEST_DATA="${JARVIS_CLASSIC_TEST_DATA}")
add_dependencies(tst_qml jarvis_ui jarvis-ui_translations jarvis-shell_translations jarvis-classic_translations)
add_test(NAME tst_qml COMMAND tst_qml)
set_tests_properties(tst_qml PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS qml TIMEOUT 120)

add_test(NAME qml_imports_listed
  COMMAND ${CMAKE_COMMAND} -DQML_DIR=${CMAKE_CURRENT_SOURCE_DIR}/../src/qml
          -DMAP=${CMAKE_CURRENT_SOURCE_DIR}/../deps/qml-runtime.txt -DSKIP=Jarvis.Classic
          -P ${CMAKE_CURRENT_SOURCE_DIR}/../../ui/cmake/check_qml_imports.cmake)
set_tests_properties(qml_imports_listed PROPERTIES LABELS unit)

add_test(NAME classic_uses_shell_controller_only
  COMMAND ${CMAKE_COMMAND} -DSRC_DIR=${CMAKE_CURRENT_SOURCE_DIR}/../src
          -P ${CMAKE_CURRENT_SOURCE_DIR}/check_no_direct_channels.cmake)
set_tests_properties(classic_uses_shell_controller_only PROPERTIES LABELS unit)
