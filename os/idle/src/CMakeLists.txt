add_library(jarvis_idle_core STATIC
  core/IdlePolicy.h core/IdlePolicy.cpp core/IdleConfig.h core/IdleConfig.cpp core/LockLauncher.h core/LockLauncher.cpp)
target_include_directories(jarvis_idle_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(jarvis_idle_core PUBLIC Qt6::Core)
