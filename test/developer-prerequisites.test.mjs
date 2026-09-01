import { describe, expect, it } from "vitest";

import {
  ADVISORY_FREE_BYTES,
  evaluateDeveloperPrerequisites,
  REQUIRED_RUST_TOOLCHAIN,
} from "../scripts/doctor-dev.mjs";

const enoughSpace = [{ path: "/workspace/target", freeBytes: ADVISORY_FREE_BYTES + 1n }];

function passingInput(platform = "darwin") {
  return {
    platform,
    nodeVersion: "22.23.2",
    rustcVersion: `rustc ${REQUIRED_RUST_TOOLCHAIN} (fixture)`,
    cargoVersion: `cargo ${REQUIRED_RUST_TOOLCHAIN} (fixture)`,
    cmakeVersion: "cmake version 4.4.3",
    xcodeSelectPath: platform === "darwin" ? "/Applications/Xcode.app/Contents/Developer" : undefined,
    clangCompilerPath: platform === "darwin" ? "/usr/bin/clang++" : "C:\\Program Files\\LLVM\\bin\\cl.exe",
    buildToolVersion: platform === "win32" ? "1.12.1" : "GNU Make 4.4",
    cmakeGenerators: platform === "win32" ? "Visual Studio 17 2022" : undefined,
    diskReports: enoughSpace,
  };
}

function passingReport(platform = "darwin") {
  return evaluateDeveloperPrerequisites(passingInput(platform));
}

describe("developer prerequisite doctor", () => {
  it("accepts the pinned cross-platform Rust toolchain and native build prerequisites", () => {
    expect(passingReport().ok).toBe(true);
    expect(passingReport("linux").ok).toBe(true);
    expect(passingReport("win32").ok).toBe(true);
  });

  it("reports low disk without blocking the doctor", () => {
    const report = evaluateDeveloperPrerequisites({
      ...passingInput(),
      diskReports: [{ path: "/workspace/target", freeBytes: ADVISORY_FREE_BYTES - 1n }],
    });

    expect(report.ok).toBe(true);
    expect(report.checks.filter(({ advisory }) => advisory).map(({ name }) => name)).toEqual([
      "Free space: /workspace/target",
    ]);
    expect(report.checks.find(({ name }) => name === "Free space: /workspace/target")).toMatchObject({
      passed: true,
      advisory: true,
    });
  });

  it("fails closed for missing or unsupported toolchains", () => {
    const report = evaluateDeveloperPrerequisites({
      ...passingInput(),
      rustcVersion: "rustc 1.87.0 (fixture)",
      cmakeVersion: "cmake version 3.14.0",
    });

    expect(report.ok).toBe(false);
    expect(report.checks.filter(({ passed }) => !passed).map(({ name }) => name)).toEqual([
      "Rust toolchain",
      "CMake",
    ]);
  });

  it("requires Apple developer tools on macOS and a supported Windows generator plus compiler", () => {
    const macReport = evaluateDeveloperPrerequisites({
      ...passingInput(),
      xcodeSelectPath: "",
      clangCompilerPath: "",
    });
    const windowsReport = evaluateDeveloperPrerequisites({
      ...passingInput("win32"),
      buildToolVersion: null,
      clangCompilerPath: null,
      cmakeGenerators: "",
    });

    expect(macReport.ok).toBe(false);
    expect(windowsReport.ok).toBe(false);
    expect(macReport.checks.filter(({ passed }) => !passed).map(({ name }) => name)).toEqual([
      "Xcode Command Line Tools",
      "Apple C++ compiler",
    ]);
    expect(windowsReport.checks.filter(({ passed }) => !passed).map(({ name }) => name)).toEqual([
      "Windows CMake generator",
      "Windows C++ compiler",
    ]);
  });

  it("accepts a Windows Visual Studio generator without Ninja", () => {
    const report = evaluateDeveloperPrerequisites({
      ...passingInput("win32"),
      buildToolVersion: null,
    });

    expect(report.ok).toBe(true);
  });
});
