# Rafiq M4 contracts §3: compile <component>/i18n/{en,ar}.ts into
# ${CMAKE_BINARY_DIR}/i18n/<catalog>_<lang>.qm, install them to
# /usr/share/jarvis/i18n/, and add the CI-gate ctests (label "i18n").
#
#   jarvis_add_translations(<catalog> TS_DIR <dir> [TARGET <target>]
#       [SOURCES <dirs scanned by lupdate>] [LINT_QML <dirs>] [LINT_CPP <dirs>]
#       [INSTALL] [TESTS])
#
# Include it from every directory that calls it or reads JARVIS_I18N_BUILD_DIR.
# There is deliberately no include_guard: os/ui includes it in its own
# directory scope, and each app must include it again to see the variable.
find_package(Qt6 6.8 REQUIRED COMPONENTS LinguistTools)
find_package(Python3 3.9 REQUIRED COMPONENTS Interpreter)
include(GNUInstallDirs)
set(JARVIS_I18N_BUILD_DIR ${CMAKE_BINARY_DIR}/i18n)

function(jarvis_add_translations catalog)
  cmake_parse_arguments(ARG "INSTALL;TESTS" "TS_DIR;TARGET" "SOURCES;LINT_QML;LINT_CPP" ${ARGN})
  set(JARVIS_I18N_TOOLS_DIR ${CMAKE_CURRENT_FUNCTION_LIST_DIR}/../i18n)
  set(JARVIS_I18N_BUILD_DIR ${CMAKE_BINARY_DIR}/i18n)
  set(qm_files "")
  foreach(lang en ar)
    set(ts ${ARG_TS_DIR}/${lang}.ts)
    set(qm ${JARVIS_I18N_BUILD_DIR}/${catalog}_${lang}.qm)
    add_custom_command(OUTPUT ${qm}
      COMMAND ${CMAKE_COMMAND} -E make_directory ${JARVIS_I18N_BUILD_DIR}
      COMMAND $<TARGET_FILE:Qt6::lrelease> -silent ${ts} -qm ${qm}
      DEPENDS ${ts}
      VERBATIM)
    list(APPEND qm_files ${qm})
  endforeach()
  add_custom_target(${catalog}_translations ALL DEPENDS ${qm_files})
  if(ARG_TARGET)
    add_dependencies(${ARG_TARGET} ${catalog}_translations)
  endif()
  if(ARG_INSTALL)
    install(FILES ${qm_files} DESTINATION ${CMAKE_INSTALL_DATADIR}/jarvis/i18n)
  endif()
  if(ARG_TESTS)
    add_test(NAME ${catalog}_i18n_complete
      COMMAND ${Python3_EXECUTABLE} ${JARVIS_I18N_TOOLS_DIR}/check_ts.py
              --component ${catalog} --en ${ARG_TS_DIR}/en.ts --ar ${ARG_TS_DIR}/ar.ts
              --lupdate $<TARGET_FILE:Qt6::lupdate> --sources ${ARG_SOURCES})
    set_tests_properties(${catalog}_i18n_complete PROPERTIES LABELS i18n TIMEOUT 120)
    add_test(NAME ${catalog}_strings_wrapped
      COMMAND ${Python3_EXECUTABLE} ${JARVIS_I18N_TOOLS_DIR}/lint_strings.py
              --qml ${ARG_LINT_QML} --cpp ${ARG_LINT_CPP})
    set_tests_properties(${catalog}_strings_wrapped PROPERTIES LABELS i18n TIMEOUT 60)
  endif()
endfunction()
