import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
const parser = JSON.parse(await readFile(require.resolve('typescript/package.json'), 'utf8'));
if (parser.version !== '5.9.3') throw new Error('Qualification requires the locked TypeScript 5.9.3 parser.');
function source(text) {
  const parsed = ts.createSourceFile('qualification.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw new Error('Authoring evidence contains invalid JavaScript.');
  return parsed;
}
const member = (expression, owner, name) => ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === owner && expression.name.text === name;
const literal = expression => expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) ? expression.text : null;
function unwrapAwait(expression) { return ts.isAwaitExpression(expression) ? expression.expression : expression; }
function constBindings(parsed) {
  return parsed.statements.filter(ts.isVariableStatement).filter(statement => statement.declarationList.flags & ts.NodeFlags.Const)
    .flatMap(statement => [...statement.declarationList.declarations]).filter(item => ts.isIdentifier(item.name) && item.initializer);
}
function wrapperCommand(input) {
  if (typeof input !== 'string') return null;
  const parsed = source(input), bindings = constBindings(parsed);
  if (parsed.statements.length !== 2 || bindings.length !== 1 || !ts.isVariableStatement(parsed.statements[0]) || parsed.statements[0].declarationList.declarations.length !== 1) return null;
  const executed = bindings.filter(item => {
    const call = unwrapAwait(item.initializer); return ts.isAwaitExpression(item.initializer) && ts.isCallExpression(call) && member(call.expression, 'tools', 'exec_command');
  });
  // A single real native exec result must be emitted intact; text(r.output)
  // discards the inner status and cannot be qualification evidence.
  if (executed.length !== 1) return null;
  const binding = executed[0], call = unwrapAwait(binding.initializer);
  if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) return null;
  const properties = call.arguments[0].properties;
  const optionNames = new Set();
  if (properties.some(item => {
    if (!ts.isPropertyAssignment(item) || !(ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) || optionNames.has(item.name.text)) return true;
    optionNames.add(item.name.text);
    return !['cmd', 'shell', 'max_output_tokens', 'yield_time_ms', 'workdir'].includes(item.name.text) || !(literal(item.initializer) !== null || ts.isNumericLiteral(item.initializer));
  })) return null;
  const command = properties.filter(item => (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === 'cmd');
  if (command.length !== 1) return null;
  const emitted = parsed.statements.filter(ts.isExpressionStatement).some(statement => {
    const emit = statement.expression;
    if (!ts.isCallExpression(emit) || !ts.isIdentifier(emit.expression) || emit.expression.text !== 'text' || emit.arguments.length !== 1) return false;
    let value = emit.arguments[0];
    if (ts.isCallExpression(value) && member(value.expression, 'JSON', 'stringify') && value.arguments.length === 1) value = value.arguments[0];
    return ts.isIdentifier(value) && value.text === binding.name.text;
  });
  return emitted ? literal(command[0].initializer) : null;
}
function submissionProgram(command, nodePath, clientModuleUrl) {
  const escaped = nodePath.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('/', '[\\\\/]');
  const quoted = `'${escaped.replaceAll("'", "''")}'`;
  // Bind the whole PowerShell command. A legitimate snippet in dead code, or
  // followed by forged stdout, does not prove the owned Node was invoked.
  const encoding = String.raw`(?:\$OutputEncoding|\[Console\]::OutputEncoding)\s*=\s*\[(?:System\.)?Text\.UTF8Encoding\]::new\(\$false\)\s*(?:;\s*)?`;
  const matched = command.match(new RegExp(`^\\s*(?:${encoding}){0,2}@'\\r?\\n([\\s\\S]*?)\\r?\\n'@\\s*\\|\\s*&\\s*${quoted}\\s+--input-type=module\\s*;?\\s*$`, 'i'));
  if (!matched || /^\s*'@/m.test(matched[1])) return null;
  const parsed = source(matched[1]);
  // Qualification uses a separate, minimal final submit command. Arbitrary
  // authoring JavaScript cannot prove it did not replace graph.submit or the
  // serializer; its earlier draft writes remain model-owned and unrestricted.
  if (![3, 4].includes(parsed.statements.length)) return null;
  const imported = parsed.statements[0];
  if (!ts.isImportDeclaration(imported) || literal(imported.moduleSpecifier) !== clientModuleUrl || imported.importClause?.name
    || !imported.importClause?.namedBindings || !ts.isNamedImports(imported.importClause.namedBindings) || imported.importClause.namedBindings.elements.length !== 1) return null;
  const client = imported.importClause.namedBindings.elements[0];
  if ((client.propertyName ?? client.name).text !== 'RelayerGraphClient' || ['JSON', 'console'].includes(client.name.text)) return null;
  const declarations = statement => ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const
    && statement.declarationList.declarations.length === 1 ? statement.declarationList.declarations[0] : null;
  const graph = declarations(parsed.statements[1]);
  if (!graph || !ts.isIdentifier(graph.name) || ['JSON', 'console', client.name.text].includes(graph.name.text)
    || !ts.isCallExpression(graph.initializer) || !member(graph.initializer.expression, client.name.text, 'fromEnv') || graph.initializer.arguments.length !== 0) return null;
  const printed = parsed.statements.at(-1);
  if (!ts.isExpressionStatement(printed) || !ts.isCallExpression(printed.expression) || !member(printed.expression.expression, 'console', 'log') || printed.expression.arguments.length !== 1) return null;
  const serialized = printed.expression.arguments[0];
  if (!ts.isCallExpression(serialized) || !member(serialized.expression, 'JSON', 'stringify') || serialized.arguments.length !== 1) return null;
  let submitted = serialized.arguments[0];
  if (parsed.statements.length === 4) {
    const result = declarations(parsed.statements[2]);
    if (!result || !ts.isIdentifier(result.name) || ['JSON', 'console', client.name.text, graph.name.text].includes(result.name.text)
      || !ts.isIdentifier(submitted) || submitted.text !== result.name.text) return null;
    submitted = result.initializer;
  }
  if (!ts.isAwaitExpression(submitted) || !ts.isCallExpression(submitted.expression) || !member(submitted.expression.expression, graph.name.text, 'submit')
    || submitted.expression.arguments.length !== 1 || !ts.isNumericLiteral(submitted.expression.arguments[0])) return null;
  const id = Number(submitted.expression.arguments[0].text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function nativeResult(call, output) {
  if (call.type === 'custom_tool_call') {
    if (!Array.isArray(output) || output.length !== 2 || output.some(item => item.type !== 'input_text') || !/^Script completed\r?\n/.test(output[0].text ?? '')) return null;
    let inner; try { inner = JSON.parse(output[1].text); } catch { return null; }
    return inner?.exit_code === 0 && inner.session_id == null && typeof inner.output === 'string' ? inner.output : null;
  }
  if (typeof output !== 'string') return null;
  const parts = output.split(/\r?\nFinal output:\r?\n/i);
  if (parts.length !== 2) return null;
  const statuses = [...parts[0].matchAll(/^(?:Process exited with code|Exit code:)\s*(-?\d+)\s*$/gim)];
  return statuses.length === 1 && Number(statuses[0][1]) === 0 ? parts[1] : null;
}
function acceptedSubmission(stdout) {
  const objects = [];
  // Real graph programs can print their saved-program ID before the complete
  // JSON API result. Do not extract IDs from free text or caller labels.
  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    if (!line.trimStart().startsWith('{')) continue;
    for (const candidate of [line, stdout.split(/\r?\n/).slice(index).join('\n')]) {
      let value; try { value = JSON.parse(candidate); } catch { continue; }
      if (value && Number.isSafeInteger(value.nodeId) && value.nodeId > 0 && value.rootAction?.sourceNodeId === value.nodeId && value.rootAction.state === 'accepted'
        && value.rootAction.kind === 'navigate' && value.rootAction.relation === 'expand' && Number.isSafeInteger(value.rootAction.id) && value.rootAction.id > 0
        && Number.isSafeInteger(value.rootLayer?.layer?.id) && value.rootLayer.layer.id > 0 && value.rootLayer.layer.state === 'accepted'
        && value.rootAction.targetLayerId === value.rootLayer.layer.id && Array.isArray(value.rootLayer.nodes) && Array.isArray(value.rootLayer.edges) && Array.isArray(value.rootLayer.actions)) {
        if (!objects.some(item => JSON.stringify(item) === JSON.stringify(value))) objects.push(value);
      }
    }
  }
  return objects.length === 1 ? objects[0] : null;
}
export async function collectWindowsAuthoringRuntime({ rolloutPath, runtimeInspectionPath, interactionNodeId, finalLayerId, notBefore }) {
  const runtimeBytes = await readFile(runtimeInspectionPath);
  const runtime = JSON.parse(runtimeBytes);
  if (runtime.schema !== 'windows-first-install-runtime/v1' || runtime.identity?.ordinaryUser !== true || runtime.identity?.authenticated !== true || runtime.identity?.administratorGroupMember !== false
    || !/^S-1-(?:\d+-)+\d+$/.test(runtime.identity.sid ?? '') || typeof runtime.identity.userProfile !== 'string' || typeof runtime.freshProfile !== 'string' || typeof runtime.installedExecutable !== 'string') throw new Error('Collected ordinary-user installed runtime inspection required.');
  const userDataDirectory = runtime.freshProfile, installedExecutable = runtime.installedExecutable;
  const [rollout, profile, executable] = await Promise.all([realpath(rolloutPath), realpath(userDataDirectory), realpath(installedExecutable)]);
  const userProfile = await realpath(runtime.identity.userProfile);
  const within = (base, path) => { const child = relative(base, path); return child !== '' && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child); };
  const homes = [{ kind: 'codex-default', path: join(userProfile, '.codex') }, { kind: 'codex-legacy', path: join(profile, 'codex-home') }];
  const providerRelative = relative(join(profile, 'provider-runtimes'), rollout).split(/[\\/]/);
  if (providerRelative.length >= 4 && /^[a-z0-9][a-z0-9._-]*$/i.test(providerRelative[0]) && providerRelative[0] !== '..' && providerRelative[1] === 'codex-home' && providerRelative[2] === 'sessions') homes.push({ kind: 'codex-provider', path: join(profile, 'provider-runtimes', providerRelative[0], 'codex-home') });
  const providerHome = homes.find(home => within(join(home.path, 'sessions'), rollout));
  if (!providerHome) throw new Error('Live authoring rollout is outside this ordinary Windows user supported Codex homes.');
  if (![interactionNodeId, finalLayerId].every(id => Number.isSafeInteger(id) && id > 0) || !Number.isFinite(Date.parse(notBefore))) throw new Error('Explicit observed interaction, final layer and launch timestamp required.');
  const appDirectory = dirname(executable), nodePath = join(appDirectory, 'resources/node/node.exe');
  const clientModuleUrl = pathToFileURL(join(appDirectory, 'resources/graph-client/index.js')).href;
  const bytes = await readFile(rollout);
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Qualification rollout exceeds the bounded input size.');
  const rows = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  for (const row of rows) {
    const call = row.payload, at = Date.parse(row.timestamp);
    if (row.type !== 'response_item' || !Number.isFinite(at) || at < Date.parse(notBefore)) continue;
    let command;
    if (call?.type === 'custom_tool_call' && call.name === 'exec') { try { command = wrapperCommand(call.input); } catch { continue; } }
    else if (call?.type === 'function_call' && ['exec_command', 'shell_command', 'functions.exec_command', 'functions.shell_command'].includes(call.name)) {
      let args; try { args = JSON.parse(call.arguments); } catch { continue; } command = args.cmd ?? args.command;
    }
    if (typeof command !== 'string') continue;
    let submittedNodeId; try { submittedNodeId = submissionProgram(command, nodePath, clientModuleUrl); } catch { continue; }
    if (submittedNodeId === null || submittedNodeId !== interactionNodeId) continue;
    const completed = rows.filter(item => item.type === 'response_item' && item.payload?.type === `${call.type}_output` && item.payload.call_id === call.call_id);
    if (completed.length !== 1 || !Number.isFinite(Date.parse(completed[0].timestamp)) || Date.parse(completed[0].timestamp) < at) continue;
    const stdout = nativeResult(call, completed[0].payload.output);
    if (stdout === null) continue;
    const result = acceptedSubmission(stdout);
    if (!result || result.nodeId !== submittedNodeId || result.rootLayer.layer.id !== finalLayerId) continue;
    return { schema: 'windows-live-authoring-runtime/v2', interactionNodeId: result.nodeId, finalLayerId: result.rootLayer.layer.id,
      submission: { nodeId: result.nodeId, rootLayerId: result.rootLayer.layer.id, rootActionId: result.rootAction.id, resultSha256: sha(JSON.stringify(result)) },
      userDataDirectory: profile, userProfile, userSid: runtime.identity.sid, providerHome: providerHome.path, providerHomeKind: providerHome.kind, installedRuntimeSha256: sha(runtimeBytes), nodePath, observedAt: completed[0].timestamp, callId: call.call_id,
      commandSha256: sha(command), rolloutPath: rollout, rolloutSha256: sha(bytes), exitCode: 0, parserVersion: parser.version };
  }
  throw new Error('No successful app-owned submission for the observed interaction and final layer in this installed-profile rollout.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rolloutPath, runtimeInspectionPath, id, layer, notBefore, output] = process.argv.slice(2);
  await writeFile(output, JSON.stringify(await collectWindowsAuthoringRuntime({ rolloutPath, runtimeInspectionPath, interactionNodeId: Number(id), finalLayerId: Number(layer), notBefore }), null, 2), { flag: 'wx' });
}
