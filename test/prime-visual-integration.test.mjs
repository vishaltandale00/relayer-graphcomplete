import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { primeVisualFixtureFactory } from "./support/prime-visual-fixture.mjs";

it.each(["prime-agent-basic", "prime-agent-deep"])("%s accepts Python authored assets and preserves old pins while promoting new threads", async (harnessId) => {
  const root = resolve('.');
  const directory = await mkdtemp(join(tmpdir(), 'prime-visual-proof-'));
  const configurationPath = join(directory, 'prime.yaml');
  const shipped = await readFile(join(root, 'harnesses', `${harnessId}.yaml`), 'utf8');
  expect(shipped).toContain('personalPresentationVersion: personal-presentation-v4');
  const configuration = shipped.replace('  personalPresentationVersion: personal-presentation-v4\n', '');
  await writeFile(configurationPath, configuration);
  const runtimeOptions = { userDataDirectory: directory,
    temporalFeatures: { schemaRead: true, rootCurrentWrite: true },
    graphServerBinary: join(root, 'target/debug/relayer-graph-server'), configurationPaths: [configurationPath],
    candidateTrace: { directory: join(directory, 'traces'), policy: { mode: 'required', requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 100_000, maxEventsPerTurn: 200 } },
    additionalImplementations: { 'prime.agent': primeVisualFixtureFactory },
    acquireProviderExecution: async (providerId) => ({
      definition: { id: providerId, adapterId: 'openai-api', accessContract: 'secret@1', endpoint: 'https://unused.invalid/v1' },
      descriptor: { adapterId: 'openai-api', accessContract: 'secret@1', implementationVersion: '2' },
      runtime: { async executionAccess() { return { kind: 'secret', contract: 'secret@1', providerId, adapterId: 'openai-api', adapterImplementationVersion: '2', endpoint: 'https://unused.invalid/v1', fields: { 'api-key': 'deterministic-unused' } }; } },
      async release() {},
    }),
  };
  let runtime = new GraphCompleteRuntimeService(runtimeOptions);
  let product;
  try {
    const runtimeSession = await runtime.start();
    const productOptions = { userDataDirectory: directory, binaryPath: join(root, 'target/debug/relayer-app-server'),
      webDirectory: join(root, 'desktop/renderer'), permissionCatalogPath: join(root, 'permissions/desktop.json'), runtimeSession,
      defaultHarnessConfiguration: harnessId, allowHarnessOverride: true, allowConversationImport: true, enableReadOnlySession: true,
      exportProducer: { desktopVersion: 'fixture', buildCommit: '0'.repeat(40), platform: 'darwin', architecture: 'arm64' },
    };
    product = new RelayerAppServerService(productOptions);
    let session = await product.start();
    await product.providerDefinitionStore().save([{ id: 'openai-work', adapterId: 'openai-api', label: 'Fixture', endpoint: 'https://unused.invalid/v1', accessContract: 'secret@1', credentialReference: 'fixture', lifecycleState: 'active', removedAt: null }]);
    await product.seedProviderCatalog({ providerId: 'openai-work', label: 'Fixture', connected: true,
      models: [{ id: 'fixture-model', label: 'Fixture', order: 0, visible: true, available: true, providerDefault: true, metadata: {} }],
      systemFamily: { key: 'fixture', name: 'Fixture', modelIds: ['fixture-model'] },
    });
    const family = await request(session, '/api/model-families', { method: 'POST', body: JSON.stringify({ name: 'Fixture', enabled: true, members: [{ providerId: 'openai-work', modelId: 'fixture-model' }] }) });
    const thread = await request(session, '/api/threads', { method: 'POST', body: JSON.stringify({ title: 'Prime visual proof', initialMessage: 'Show a visual answer', permissionProfileId: 'full', harnessId: harnessId, modelSelection: { familyId: family.id, providerId: 'openai-work', modelId: 'fixture-model' } }) });
    let detail;
    for (let attempt = 0; attempt < 200; attempt++) {
      detail = await request(session, `/api/threads/${thread.id}`);
      if (detail.interactions[0]?.completionStatus === 'accepted') break;
      if (detail.interactions[0]?.completionStatus === 'failed') {
        const target = join(directory, 'failed-trace');
        await runtime.exportCandidateTrace(detail.interactions[0].id, target).catch(() => {});
        console.error(await readFile(join(target, 'events.jsonl'), 'utf8').catch(() => 'no trace'));
        throw new Error(JSON.stringify(detail.interactions[0]));
      }
      await new Promise((done) => setTimeout(done, 25));
    }
    expect(detail.interactions[0].completionStatus, JSON.stringify(detail)).toBe('accepted');
    const turn = detail.interactions[0];
    const node = turn.completionOutput.rootLayer.nodes[0];
    expect(node.authoredDetail.assets).toHaveLength(1);
    expect(node.authoredDetail.mounts).toHaveLength(6);
    const original = structuredClone(node.authoredDetail);
    const bytes = await product.exportConversation(thread.id);
    const exportPath = join(directory, 'prime.jsonl'); await writeFile(exportPath, bytes);
    if (process.env.RELAYER_PRIME_VISUAL_EXPORT) await writeFile(process.env.RELAYER_PRIME_VISUAL_EXPORT, bytes);
    const records = Buffer.from(bytes).toString().trim().split('\n').map(JSON.parse);
    expect(records.filter((item) => item.recordType === 'visualAssetContent')).toHaveLength(1);
    const evalService = await new EvalService({ stateFile: join(directory, 'eval/test-runs.json'), productSession: session, configurationPaths: [], conversationImportEnabled: true }).open();
    const imported = await evalService.importConversation(exportPath);
    const importedDetail = await request(session, `/api/threads/${imported.executions[0].threadIds[0]}`);
    const importedTurn = importedDetail.interactions[0];
    const importedNode = importedTurn.completionOutput.rootLayer.nodes[0];
    expect(importedNode.authoredDetail).toEqual(original);
    const asset = await request(session, `/api/threads/${importedDetail.thread.id}/interactions/${importedTurn.id}/nodes/${importedNode.id}/detail-assets/${original.assets[0].id}?layerId=${importedTurn.completionOutput.rootLayer.layer.id}`);
    expect(asset.digestSha256).toBe(original.assets[0].digestSha256);
    await product.close(); await runtime.close();
    await writeFile(configurationPath, shipped);
    runtime = new GraphCompleteRuntimeService(runtimeOptions);
    product = new RelayerAppServerService({ ...productOptions, runtimeSession: await runtime.start() });
    session = await product.start();
    const reopened = await request(session, `/api/threads/${thread.id}`);
    expect(reopened.interactions[0].completionOutput.rootLayer.nodes[0].authoredDetail).toEqual(original);
    await request(session, `/api/threads/${thread.id}/interactions`, { method: 'POST', body: JSON.stringify({ text: 'Continue after promotion', modelSelection: { familyId: family.id, providerId: 'openai-work', modelId: 'fixture-model' } }) });
    const continued = await acceptedTurn(session, thread.id, 1);
    const continuedTrace = await runtime.exportCandidateTrace(continued.id, join(directory, 'continued-trace'));
    expect(continuedTrace.personalPresentationVersionKey).toBe('personal-presentation-v1');
    const fresh = await request(session, '/api/threads', { method: 'POST', body: JSON.stringify({ title: 'Promoted Prime', initialMessage: 'New visual answer', permissionProfileId: 'full', harnessId: harnessId, modelSelection: { familyId: family.id, providerId: 'openai-work', modelId: 'fixture-model' } }) });
    const freshTurn = await acceptedTurn(session, fresh.id, 0);
    const freshTrace = await runtime.exportCandidateTrace(freshTurn.id, join(directory, 'fresh-trace'));
    expect(freshTrace.personalPresentationVersionKey).toBe('personal-presentation-v4');
    expect(freshTurn.completionOutput.rootLayer.nodes).toHaveLength(1);
    expect(freshTurn.completionOutput.rootLayer.nodes[0].authoredDetail).toBeDefined();
    expect(freshTurn.completionOutput.rootLayer.nodes[0].title).toBe('Result');
    expect(freshTurn.completionOutput.rootLayer.nodes[0].authoredDetail.mounts).toHaveLength(1);
    expect(freshTurn.completionOutput.rootLayer.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'navigate', relation: 'reference', label: 'Earlier findings' }),
    ]));
    const expansion = freshTurn.completionOutput.rootLayer.actions.find((action) => action.label === 'Earlier findings');
    const child = await request(session, `/api/threads/${fresh.id}/interactions/${freshTurn.id}/layers/${expansion.targetLayerId}`);
    expect(child.nodes[0].title).toBe('Initial finding');
    expect(child.nodes[0].authoredDetail.components[0].html).toContain('Replace with supported evidence and uncertainty.');
    expect(freshTurn.completionOutput.rootLayer.nodes[0].authoredDetail.mounts[0].capability.action.clientKey).toBe(expansion.clientKey);
    const evidenceAction = child.actions.find((action) => action.label === 'Evidence');
    expect(evidenceAction).toMatchObject({ kind: 'navigate', relation: 'expand' });
    const evidence = await request(session, `/api/threads/${fresh.id}/interactions/${freshTurn.id}/layers/${evidenceAction.targetLayerId}`);
    expect(evidence.nodes[0].authoredDetail.components[0].html).toContain('Replace with useful supporting detail.');

  } finally {
    await product?.close(); await runtime.close(); await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

async function request(session, path, options = {}) {
  const response = await fetch(new URL(path, session.origin), { ...options, headers: { Cookie: `${session.cookie.name}=${session.cookie.value}`, ...(options.body ? { 'content-type': 'application/json' } : {}) } });
  const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body;
}

async function acceptedTurn(session, threadId, index) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const detail = await request(session, `/api/threads/${threadId}`);
    const turn = detail.interactions[index];
    if (turn?.completionStatus === 'accepted') return turn;
    if (turn?.completionStatus === 'failed' || turn?.latestAttempt?.finishedAt) throw new Error(JSON.stringify(turn));
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error('Prime continuation did not accept');
}
