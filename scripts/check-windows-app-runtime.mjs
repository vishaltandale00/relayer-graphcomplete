import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { prepareWindowsAppRuntime } from '../desktop/packaging/windows-app-runtime.mjs';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 runtime preflight requires its declared platform.');
execFileSync('perl', ['-e', "die qq(Native Windows Perl required) unless $^O eq 'MSWin32'; require IPC::Cmd; print qq(native-perl-ok)"], { stdio: 'inherit' });
const runtime = await prepareWindowsAppRuntime({ repositoryRoot: resolve(import.meta.dirname, '..') });
execFileSync(`${runtime.node}\\node.exe`, ['--version'], { stdio: 'inherit' });
console.log('Pinned app-owned Node and Microsoft-signed app-local CRT inputs verified before native compilation.');
