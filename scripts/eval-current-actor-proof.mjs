import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { RelayerGraphClient, LayerObject, LayerLayoutObject, NodeObject, NodePlacementObject, html, detailCapability } from "@relayer/graph-client";
import { GraphCompleteRuntimeService, RECURSIVE_TEMPORAL_FEATURES } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { HumanTaskService } from "../desktop/eval-main/human-task-service.mjs";
import { TaskActorService } from "../desktop/eval-main/task-actor-service.mjs";
import { openTaskActorBrowser } from "../desktop/eval-main/task-actor-browser.mjs";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export async function proveCurrentActor({ browser, directory, authored = false }) {
  const data = join(directory, authored ? "current-actor-authored" : "current-actor");
  await mkdir(data, { recursive: true });
  const configuration = join(data, "fixture-current-actor.yaml");
  await writeFile(configuration, "schemaVersion: 1\nname: fixture-current-actor\nimplementation: fixture.current-actor\nimplementationVersion: 1\npermissionBindings:\n  ask: {}\n  auto: {}\n  full: {}\nmodelCompatibility:\n  - providerId: codex\nexecutionAccessContracts: [managed-runtime@1]\nsettings: {}\n");
  const gates = [deferred(), deferred(), deferred()];
  const layers = [];
  const resources = [];
  let controller;
  let tasks;
  let actorPage;
  let receivedAnswer;
  let harnessCalls = 0;
  let answerRequests = 0;
  let deniedAdmissionChecked = false;
  try {
    const binaries = resolve(process.env.CARGO_TARGET_DIR || "target", "debug");
    const runtime = new GraphCompleteRuntimeService({ userDataDirectory: data, graphServerBinary: join(binaries, "relayer-graph-server"), configurationPaths: [configuration], temporalFeatures: RECURSIVE_TEMPORAL_FEATURES,
      acquireProviderExecution: async providerId => ({ definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" }, descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" }, runtime: { executionAccess: async () => ({ kind: "managed-runtime", environment: {} }) }, async release() {} }),
      additionalImplementations: { "fixture.current-actor": () => ({ state: () => ({}),
        async complete(context, signal) {
          const capability = context.graph.acquireCapability();
          const graph = new RelayerGraphClient(capability);
          harnessCalls++;
          const initialContract = await graph.getContract();
          await gates[0].promise;
          let revision = 0;
          for (let index = 1; index <= 2; index++) {
            const node = new NodeObject("search", `Working finding ${index}`, index === 1 ? "I found the queue and am checking the worker boundary." : "The worker boundary explains the delay. Earlier findings remain linked.", "concept", `finding-${index}`);
            const layer = new LayerObject([node], [], new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)], "default"), `working-${index}`);
            const question = { kind: "input", control: "text", prompt: "Which boundary should I inspect?", label: "Investigation boundary", sourceLayer: layer, clientKey: "boundary" };
            if (authored && index === 1) node.detailAuthoring.setComponent("question", html`<label>Which boundary should I inspect?<textarea aria-label="Which boundary should I inspect?" gc=${detailCapability.input("boundary", question)}></textarea></label>`);
            await graph.submitNode(node);
            await graph.submitLayer(layer);
            if (index === 1) await graph.addAction(node, question);
            if (index === 2) await graph.addAction(node, { kind: "navigate", relation: "reference", sourceLayer: layer, label: "Earlier finding", target: layers[0], clientKey: "earlier" });
            await graph.addAction(context.inputGraph.id, { kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: "response" });
            layers.push(layer);
            revision = (await graph.advanceCurrent(layer, revision, `working-${index}`)).revision;
            if (index === 1) {
              const unanswered = await graph.getLiveAnswers();
              assert.equal(unanswered.answers.length, 0, "staged values are not accepted input");
              assert.equal(unanswered.eligibleActionIds.length, 1, "published ordinary root question is eligible");
              assert.equal((await fetch(`${capability.url}/api/graph/live-answers`, { method: "POST", headers: { Authorization: `Bearer ${capability.token}`, "Content-Type": "application/json" }, body: "{}" })).status, 405, "candidate read capability cannot answer itself");
              assert.equal((await fetch(`${capability.url}/api/control/interactions/${context.inputGraph.id}/live-answers`, { method: "POST", headers: { Authorization: `Bearer ${capability.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ threadId: 1, answer: { attemptId: 1, authorityEpoch: unanswered.authorityEpoch, expectedRevision: revision, operationKey: "forged-answer", occurrence: { presentingInteractionNodeId: context.inputGraph.id, presentingLayerId: layer.ref.id, actionId: unanswered.eligibleActionIds[0] }, value: { text: "Not admitted" } } }) })).status, 401, "candidate has no Product answer authority");
              const answers = await graph.waitForLiveAnswers(0, 20000, signal);
              assert.equal(answers.answers.length, 1);
              receivedAnswer = answers.answers[0];
              assert.equal(receivedAnswer.value.text, "Worker");
              assert.equal(receivedAnswer.question.prompt, "Which boundary should I inspect?");
              assert.deepEqual(await graph.getContract(), initialContract, "live answer preserves sealed input");
              await gates[1].promise;
            } else await gates[index].promise;
          }
          await graph.returnCurrent(layers[1], revision, "finished");
        },
      }) },
    });
    resources.push(runtime);
    const product = new RelayerAppServerService({ userDataDirectory: data, binaryPath: join(binaries, "relayer-app-server"), webDirectory: resolve("desktop/renderer"), permissionCatalogPath: resolve("permissions/desktop.json"), runtimeSession: await runtime.start(), defaultHarnessConfiguration: "fixture-current-actor", allowHarnessOverride: true, evalMode: true, enableReadOnlySession: true });
    resources.push(product);
    const productSession = await product.start();
    await product.seedProviderCatalog({ providerId: "codex", label: "Fixture", connected: true, models: [{ id: "fixture-model", label: "Fixture", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }], systemFamily: { key: "codex", name: "Fixture", modelIds: ["fixture-model"] } });
    const familyResponse = await fetch(new URL("/api/model-families", productSession.origin), {
      method: "POST",
      headers: { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fixture models", enabled: true, members: [{ providerId: "codex", modelId: "fixture-model" }] }),
    });
    assert.equal(familyResponse.status, 201, await familyResponse.text());
    const service = await new EvalService({ stateFile: join(data, "eval-data/test-runs.json"), productSession, configurationPaths: [configuration] }).open();
    tasks = await new HumanTaskService({ stateFile: join(data, "tasks.json"), evalService: service, productSession }).open();
    const reactions = [];
    const actors = new TaskActorService({ tasks, pollMs: 10, deadlineMs: 30000, resolveRuntime: async () => ({}),
      openBrowser: async (sessionId, signal, observationContract) => {
        controller = await openTaskActorBrowser({ tasks, sessionId, productSession, browser, signal, observationContract });
        actorPage = browser.contexts().at(-1).pages()[0];
        const originalAct = controller.act.bind(controller);
        controller.act = async (...args) => {
          try {
            await originalAct(...args);
            if (args[0].kind === "click" && !receivedAnswer) assert.equal(answerRequests, 1, "one explicit Answer click must deliver the staged value");
          } catch (error) { console.error("CURRENT_ACTOR_ACTION_FAILURE", error.message, error.code, error.actionDispatched); throw error; }
        };
        await actorPage.route("**/api/threads/*/interactions/*/live-answers", async route => {
          if (route.request().method() !== "POST") return route.continue();
          answerRequests++;
          const response = await route.fetch();
          assert.equal(response.status(), 200, await response.text());
          await route.abort("failed"); // Graph accepted; UI reconciles the lost response.
        });
        gates[0].resolve(); return controller;
      },
      createActor: async () => ({ close: async () => {},
        observe: async observation => {
          try {
          assert.deepEqual(observation.availableActions, ["click", "fill", "select", "scroll"]);
          assert.ok(observation.screenshot);
          reactions.push(observation.currentUpdate.revision);
          assert.equal((await tasks.detail(tasks.list()[0].currentThreadId)).interactions.at(-1).completionStatus, "running");
          if (observation.currentUpdate.revision === 1) {
            if (receivedAnswer) {
              assert.ok(await actorPage.getByRole("button", { name: "Delivered answer for Which boundary should I inspect?", exact: true }).isDisabled());
              gates[1].resolve();
              return { comment: "My answer was delivered; I am waiting for the investigation", action: null, usage: null };
            }
            if (!deniedAdmissionChecked) {
              deniedAdmissionChecked = true;
              const threadId = tasks.list()[0].currentThreadId;
              const turn = (await tasks.detail(threadId)).interactions.at(-1);
              const headers = { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`, "Content-Type": "application/json" };
              const path = `/api/threads/${threadId}/interactions/${turn.id}/live-answers`;
              const page = await (await fetch(new URL(path, productSession.origin), { headers })).json();
              const answer = { attemptId: turn.latestAttempt.id, authorityEpoch: page.authorityEpoch,
                expectedRevision: page.current.headRevision, operationKey: "denied-proof", occurrence: {
                  presentingInteractionNodeId: page.current.completionId, presentingLayerId: page.current.currentLayerId,
                  actionId: page.eligibleActionIds[0] }, value: { text: "Staged values stay private" } };
              assert.equal((await fetch(new URL(path, productSession.origin), { method: "POST", headers,
                body: JSON.stringify({ ...answer, attemptId: answer.attemptId + 1 }) })).status, 409);
              assert.equal((await fetch(new URL(path, productSession.origin), { method: "POST", headers,
                body: JSON.stringify({ ...answer, expectedRevision: 0 }) })).status, 422);
              const read = productSession.readOnlyCookie;
              assert.equal((await fetch(new URL(path, productSession.origin), { method: "POST", headers: { ...headers, Cookie: `${read.name}=${read.value}` }, body: JSON.stringify(answer) })).status, 403);
              assert.equal((await (await fetch(new URL(path, productSession.origin), { headers })).json()).answers.length, 0);
            }
            const kind = reactions.filter(revision => revision === 1).length === 1 ? "fill" : "click";
            const control = observation.controls.find(item => item.name === (kind === "fill" ? "Which boundary should I inspect?" : "Answer Which boundary should I inspect?"));
            if (!control) {
              const threadId = tasks.list()[0].currentThreadId;
              const detail = await tasks.detail(threadId);
              const turn = detail.interactions.at(-1);
              const headers = { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}` };
              const liveResponse = await fetch(new URL(`/api/threads/${threadId}/interactions/${turn.id}/live-answers`, productSession.origin), { headers });
              const layerResponse = await fetch(new URL(`/api/threads/${threadId}/interactions/${turn.id}/layers/${(await actorPage.evaluate(() => window.__taskActorPresentation)).layerId}`, productSession.origin), { headers });
              console.error("LIVE_QUESTION_DIAGNOSTIC", JSON.stringify({ attempt: turn.latestAttempt, live: await liveResponse.text(), layer: await layerResponse.text() }));
            }
            assert.ok(control, JSON.stringify(observation.controls));
            return { comment: "I understand the decision and choose Worker", action: { kind, ref: control.ref, value: kind === "fill" ? "Worker" : "", reason: "", satisfaction: null, comment: "Answer the working question", endpointStatus: null, remainingWork: "" }, usage: null };
          }
          gates[observation.currentUpdate.revision].resolve();
          return { comment: `I understand finding ${observation.currentUpdate.revision}`, usage: null };
          } catch (error) {
            console.error("CURRENT_ACTOR_OBSERVE_FAILURE", error.message);
            await actorPage.screenshot({ path: resolve(".relayer/current-pointers-live-failure.png") }).catch(() => {});
            throw error;
          }
        },
        decide: async () => {
          assert.deepEqual(reactions, [1, 1, 1, 2]);
          assert.equal((await tasks.detail(tasks.list()[0].currentThreadId)).interactions.at(-1).completionStatus, "accepted");
          // Ordinary navigation really pins the workspace. It must not expose an
          // unseen Current as though the actor were still following it.
          const view = await controller.observe();
          const submission = tasks.get(tasks.list()[0].id).events.find(event => event.kind === "submission");
          const expected = { threadId: submission.threadId, turnId: submission.interactionId, submittedAt: Date.parse(submission.at) };
          const stage = actorPage.locator("#graphStage");
          await stage.evaluate(element => element.classList.add("hidden"));
          assert.equal(await controller.observeCurrent(expected), null, "hidden graph is not observed Current");
          await stage.evaluate(element => { element.classList.remove("hidden"); element.style.maxWidth = "0px"; });
          assert.equal(await stage.evaluate(element => element.getBoundingClientRect().width), 0);
          assert.equal(await controller.observeCurrent(expected), null, "zero-width graph is not observed Current");
          await stage.evaluate(element => element.style.removeProperty("max-width"));

          const captureCancellation = new AbortController();
          const abortBrowser = await openTaskActorBrowser({ tasks, sessionId: tasks.list()[0].id, productSession, browser, signal: captureCancellation.signal });
          const abortPage = browser.contexts().at(-1).pages()[0];
          const reached = deferred(); const release = deferred();
          abortPage.screenshot = async () => { reached.resolve(); await release.promise; return Buffer.alloc(0); };
          try {
            const pending = abortBrowser.observeCurrent(expected);
            await reached.promise;
            const reason = new Error("Capture cancelled");
            captureCancellation.abort(reason);
            await assert.rejects(pending, error => error === reason);
          } finally { release.resolve(); await abortBrowser.close(); }

          const screenshot = actorPage.screenshot.bind(actorPage);
          actorPage.screenshot = async options => {
            await actorPage.getByRole("button", { name: "Earlier finding", exact: true }).click();
            await actorPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            return screenshot(options);
          };
          try {
            assert.equal((await controller.observeCurrent(expected)).reason, "presentation_changed_during_capture");
          } finally { actorPage.screenshot = screenshot; }
          assert.equal(await controller.observeCurrent(expected), null);
          await actorPage.getByRole("button", { name: "Delivered answer for Which boundary should I inspect?", exact: true }).waitFor();
          assert.equal(await actorPage.getByRole("textbox", { name: "Which boundary should I inspect?", exact: true }).inputValue(), "Worker");
          assert.equal(await actorPage.getByRole("textbox", { name: "Which boundary should I inspect?", exact: true }).isDisabled(), true);
          await actorPage.reload();
          await actorPage.locator(".workspace-layout").waitFor();
          const earlier = actorPage.getByRole("button", { name: "Earlier finding", exact: true });
          if (await earlier.isVisible()) await earlier.click();
          await actorPage.getByRole("button", { name: "Delivered answer for Which boundary should I inspect?", exact: true }).waitFor();
          assert.equal(await actorPage.getByRole("textbox", { name: "Which boundary should I inspect?", exact: true }).inputValue(), "Worker");
          const threadId = tasks.list()[0].currentThreadId;
          const draft = await (await fetch(new URL(`/api/threads/${threadId}/input-draft`, productSession.origin), { headers: { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}` } })).json();
          assert.deepEqual(draft.attachments, [], "historical Delivered answer stays out of ordinary composer");
          return { action: { kind: "finish", ref: "", value: "", reason: "satisfied", satisfaction: 3, comment: "I followed the investigation", endpointStatus: "incomplete", remainingWork: "This is a fixture" }, usage: null };
        },
      }),
    });
    resources.push(actors);
    const task = await actors.create({ testCaseId: "empty-project.task-system.two-turn", harnessConfigurationName: "fixture-current-actor", maxCompletions: 1, endpoint: "Understand the work", actor: { maxActions: 8 } });
    await actors.running.get(task.id).done;
    const result = tasks.get(task.id);
    assert.equal(result.status, "completed", JSON.stringify(result.events.filter(event => event.kind === "actor_error")));
    const working = result.events.filter(event => event.kind === "actor_observation" && event.phase === "current");
    assert.deepEqual(working.map(event => event.pointer.revision), [1, 1, 1, 2]);
    assert.equal(answerRequests, 1, "lost UI response was reconciled without replay");
    assert.equal(harnessCalls, 1, "answer did not restart inference");
    assert.equal(result.completions, 1, "answer did not admit another completion");
    assert.ok(receivedAnswer);
    const delivery = result.events.filter(event => event.kind === "product_action" && event.path.endsWith("/live-answers") && event.outcome === "accepted");
    assert.equal(delivery.length, 1);
    assert.deepEqual(delivery[0].liveAnswerReceipt, receivedAnswer);
    assert.equal(result.events.some(event => event.kind === "actor_current_gap"), false);
    assert.ok(working[0].observation.screenshotArtifact.sha256 !== working[3].observation.screenshotArtifact.sha256);
    const reopened = await new HumanTaskService({ stateFile: join(data, "tasks.json"), evalService: service, productSession }).open();
    const { bundle } = await reopened.export(task.id);
    assert.equal(bundle.actorScreenshots.length, 5);
    assert.deepEqual(bundle.session.events.find(event => event.id === delivery[0].id).liveAnswerReceipt, receivedAnswer);
    assert.equal(bundle.session.events.filter(event => event.kind === "actor_current_reaction").length, 4);
    console.log(`PASS current-pointer actor (${authored ? "authored" : "native"} input): two real Advances with a live UI answer consumed through the candidate SDK, sealed input unchanged, response-loss reconciliation, one inference/one admission, ordered screenshot/reaction export, fresh settled decision, hidden/zero-width exclusion, capture cancellation/race, historical Delivered after navigation/reload, composer exclusion and ordinary navigation pin exclusion (fixture inference)`);
  } catch (error) {
    console.error("CURRENT_ACTOR_PROOF_FAILURE", error.message);
    if (actorPage && !actorPage.isClosed()) await actorPage.screenshot({ path: resolve(".relayer/current-pointers-live-failure.png") }).catch(() => {});
    throw error;
  } finally {
    gates.forEach(gate => gate.resolve());
    for (const resource of resources.reverse()) await resource.close();
  }
}
