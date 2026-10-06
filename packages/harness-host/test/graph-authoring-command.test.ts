import { expect, it } from 'vitest';
import { appOwnedNodeCommand, appOwnedNodeInstructions } from '../src/implementations/graph-authoring-command.js';
it('quotes Unicode Windows profiles and requires UTF-8 PowerShell stdin', () => {
  expect(appOwnedNodeCommand('C:\\Users\\José 汉字 #1\\Relayer\\node.exe')).toBe("& 'C:/Users/José 汉字 #1/Relayer/node.exe' --input-type=module");
  expect(appOwnedNodeInstructions('C:\\Relayer\\node.exe')).toContain('$OutputEncoding = [System.Text.UTF8Encoding]::new($false)');
});
it('rejects interpolation, relative paths and parent escapes', () => {
  for (const path of ['node.exe', 'C:/foo/../node.exe', 'C:/foo/"/node.exe']) expect(() => appOwnedNodeCommand(path)).toThrow('shell-safe absolute Windows');
});

it('quotes legal Windows shell metacharacters literally without interpolation', () => {
  const path = "C:/Users/O'Brien $() `x; 汉字/Relayer/node.exe";
  expect(appOwnedNodeCommand(path)).toBe("& 'C:/Users/O''Brien $() `x; 汉字/Relayer/node.exe' --input-type=module");
  expect(appOwnedNodeCommand(path, 'bash')).toBe(`'C:/Users/O'"'"'Brien $() \`x; 汉字/Relayer/node.exe' --input-type=module`);
});
