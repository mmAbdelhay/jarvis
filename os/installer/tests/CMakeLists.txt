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
