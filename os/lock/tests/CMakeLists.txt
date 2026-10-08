set(JARVIS_SHELL_TEST_SUPPORT ${CMAKE_CURRENT_SOURCE_DIR}/../../shell/tests/support)
file(GLOB JARVIS_LOCK_TEST_SUPPORT CONFIGURE_DEPENDS
  ${CMAKE_CURRENT_SOURCE_DIR}/support/*.cpp ${CMAKE_CURRENT_SOURCE_DIR}/support/*.h)

function(jarvis_lock_test source label)
  get_filename_component(name ${source} NAME_WE)
  qt_add_executable(${name} ${source} ${JARVIS_LOCK_TEST_SUPPORT}
    ${JARVIS_SHELL_TEST_SUPPORT}/FakeDaemon.h ${JARVIS_SHELL_TEST_SUPPORT}/FakeDaemon.cpp)
  target_include_directories(${name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/support ${JARVIS_SHELL_TEST_SUPPORT})
  target_link_libraries(${name} PRIVATE jarvis_lock_core Qt6::Test)
  add_test(NAME ${name} COMMAND ${name})
  set_tests_properties(${name} PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS ${label} TIMEOUT 60)
endfunction()

file(GLOB JARVIS_LOCK_UNIT_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/unit/tst_*.cpp)
list(FILTER JARVIS_LOCK_UNIT_TESTS EXCLUDE REGEX "tst_pam\\.cpp$")
foreach(source IN LISTS JARVIS_LOCK_UNIT_TESTS)
  jarvis_lock_test(${source} unit)
endforeach()

# Real PAM through pam_wrapper + pam_matrix (Linux CI): no real account is touched.
if(JARVIS_LOCK_PAM)
  find_library(PAM_WRAPPER_LIBRARY NAMES pam_wrapper libpam_wrapper.so.0)
  find_file(PAM_MATRIX_MODULE pam_matrix.so PATHS
    /usr/lib/x86_64-linux-gnu/pam_wrapper /usr/lib/aarch64-linux-gnu/pam_wrapper /usr/lib/pam_wrapper /usr/lib64/pam_wrapper)
  if(PAM_WRAPPER_LIBRARY AND PAM_MATRIX_MODULE)
    set(JARVIS_PAM_DIR ${CMAKE_CURRENT_BINARY_DIR}/pam-services)
    file(MAKE_DIRECTORY ${JARVIS_PAM_DIR})
    file(WRITE ${JARVIS_PAM_DIR}/jarvis-lock
      "auth required ${PAM_MATRIX_MODULE} passdb=${JARVIS_PAM_DIR}/passdb\naccount required ${PAM_MATRIX_MODULE} passdb=${JARVIS_PAM_DIR}/passdb\n")
    jarvis_lock_test(${CMAKE_CURRENT_SOURCE_DIR}/unit/tst_pam.cpp pam)
    target_compile_definitions(tst_pam PRIVATE JARVIS_PAM_PASSDB="${JARVIS_PAM_DIR}/passdb")
    set_tests_properties(tst_pam PROPERTIES ENVIRONMENT
      "QT_QPA_PLATFORM=offscreen;LD_PRELOAD=${PAM_WRAPPER_LIBRARY};PAM_WRAPPER=1;PAM_WRAPPER_SERVICE_DIR=${JARVIS_PAM_DIR}")
  else()
    message(WARNING "libpam-wrapper not found: tst_pam is not built (install libpam-wrapper)")
  endif()
endif()

qt_add_executable(tst_lock_qml qml/tst_qml.cpp ${JARVIS_LOCK_TEST_SUPPORT})
target_include_directories(tst_lock_qml PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/support)
target_link_libraries(tst_lock_qml PRIVATE jarvis_lock_core jarvis_lock_coreplugin Qt6::QuickTest)
target_compile_definitions(tst_lock_qml PRIVATE
  QUICK_TEST_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/qml" JARVIS_QML_DIR="${QT_QML_OUTPUT_DIRECTORY}")
add_dependencies(tst_lock_qml jarvis_ui)
add_test(NAME tst_lock_qml COMMAND tst_lock_qml)
set_tests_properties(tst_lock_qml PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen" LABELS qml TIMEOUT 120)

add_test(NAME qml_imports_listed
  COMMAND ${CMAKE_COMMAND} -DQML_DIR=${CMAKE_CURRENT_SOURCE_DIR}/../src/qml
          -DMAP=${CMAKE_CURRENT_SOURCE_DIR}/../deps/qml-runtime.txt -DSKIP=Jarvis.Lock
          -P ${CMAKE_CURRENT_SOURCE_DIR}/../../ui/cmake/check_qml_imports.cmake)
set_tests_properties(qml_imports_listed PROPERTIES LABELS unit)
