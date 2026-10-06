import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
export async function windowsDevStatus({ repositoryRoot = resolve(import.meta.dirname, '..'), resourceGroup = 'RELAYER-DESKTOP-CANARY', vm = 'relayer-win11' } = {}) {
  const evidence = join(repositoryRoot, '.relayer/windows-dev-sync'); await mkdir(evidence, { recursive: true });
  const scriptPath = join(evidence, 'status.ps1');
  await writeFile(scriptPath, `$ErrorActionPreference='Stop'
$root='C:\\RelayerDev'
$lease=$null; if(Test-Path "$root\\active-loop.json"){$lease=Get-Content "$root\\active-loop.json" -Raw | ConvertFrom-Json}
$claim=$null; if(Test-Path "$root\\build-claim.lock"){$claim=Get-Content "$root\\build-claim.lock" -Raw | ConvertFrom-Json}
$command=$null; if(Test-Path "$root\\commands.jsonl"){$command=([string](Get-Content "$root\\commands.jsonl" -Tail 1)) | ConvertFrom-Json}
$build=$null; if(Test-Path "$root\\loops.jsonl"){$build=([string](Get-Content "$root\\loops.jsonl" -Tail 1)) | ConvertFrom-Json}
$active=@(Get-Process -Name cargo,rustc,cl,link,nmake,cmake -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,CPU)
[PSCustomObject]@{schema='windows-dev-status/v1';observedAt=[DateTime]::UtcNow.ToString('o');lease=$lease;claim=$claim;lastCommand=$command;lastBuild=$build;activeCompilers=$active} | ConvertTo-Json -Compress -Depth 10
`);
  const result = await exec('az', ['vm', 'run-command', 'invoke', '--resource-group', resourceGroup, '--name', vm, '--command-id', 'RunPowerShellScript', '--scripts', `@${scriptPath}`, '--output', 'json'], { maxBuffer: 1024 * 1024 });
  const output = JSON.parse(result.stdout), message = output.value?.find(item => item.code === 'ComponentStatus/StdOut/succeeded')?.message;
  const status = JSON.parse(message); if (status.schema !== 'windows-dev-status/v1') throw new Error('Windows status did not return a valid observation.');
  await writeFile(join(evidence, 'status.json'), JSON.stringify(status, null, 2)); console.log(JSON.stringify(status)); return status;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await windowsDevStatus();
