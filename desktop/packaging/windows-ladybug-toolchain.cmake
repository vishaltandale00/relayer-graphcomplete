# Ladybug bundles every dependency into one COFF archive. Embedded C/C++ debug
# data can exceed the librarian 4 GiB limit; shared compiler PDBs also cannot
# travel safely with cached objects. Omit Ladybug private C/C++ debug data in
# every configuration. Rust release debug=1 and matching EXE/PDB gates remain.
if(NOT POLICY CMP0141)
  message(FATAL_ERROR "Relayer Windows Ladybug requires CMake 3.25 or newer")
endif()
# Ladybug declares CMake 3.15 before loading the toolchain. Toolchain includes
# scope policy changes, so apply this file again at the top-level hook: CMake
# executes that hook after the toolchain and before the first language starts.
set(CMAKE_PROJECT_TOP_LEVEL_INCLUDES "${CMAKE_CURRENT_LIST_FILE}")
cmake_policy(SET CMP0141 NEW)
set(CMAKE_POLICY_DEFAULT_CMP0141 NEW)
set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT "")
