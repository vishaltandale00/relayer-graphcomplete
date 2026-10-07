# Shared compiler PDBs are unsafe to reuse across cached C++ objects. Keep full
# debug information in each object; the linker still emits the final EXE PDB.
if(NOT POLICY CMP0141)
  message(FATAL_ERROR "Relayer Windows Ladybug requires CMake 3.25 or newer")
endif()
set(CMAKE_POLICY_DEFAULT_CMP0141 NEW)
set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT "$<$<CONFIG:Debug,RelWithDebInfo>:Embedded>")
