import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runElectronProof } from "../scripts/electron-proof-process.mjs";

const fixtures = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture(body) {
  const directory = await mkdtemp(join(tmpdir(), "electron-proof-process-test-"));
  fixtures.push(directory);
  const marker = join(directory, "profile.json");
  const script = join(directory, "child.mjs");
  await writeFile(script, `import {access,writeFile} from 'node:fs/promises';
const profile=process.env.PROOF_PROFILE;
const result=process.env.PROOF_RESULT;
await writeFile(${JSON.stringify(marker)},JSON.stringify({profile}));
${body}`);
  const run = () => runElectronProof({ executable: process.execPath, script, label: "Fixture proof",
    resultVariable: "PROOF_RESULT", profileVariable: "PROOF_PROFILE", timeoutMs: 2_000 });
  return { run, marker };
}

async function expectRemoved(marker) {
  const { profile } = JSON.parse(await readFile(marker, "utf8"));
  await expect(access(dirname(profile))).rejects.toMatchObject({ code: "ENOENT" });
}

it("keeps the profile through the child reset and removes it after successful exit", async () => {
  const { run, marker } = await fixture(`await writeFile(result,JSON.stringify({passed:false}));
await new Promise(resolve=>setTimeout(resolve,30));
await access(profile);await writeFile(result,JSON.stringify({passed:true}));`);
  await run();
  await expectRemoved(marker);
});

it.each([
  ["nonzero exit despite a positive receipt", 'await writeFile(result,JSON.stringify({passed:true}));process.exitCode=7;'],
  ["missing receipt despite zero exit", ""],
  ["unfinished or failed child reset", 'await writeFile(result,JSON.stringify({passed:false}));'],
])("rejects %s and still removes the exited child's profile", async (_name, body) => {
  const { run, marker } = await fixture(body);
  await expect(run()).rejects.toThrow("Fixture proof failed:");
  await expectRemoved(marker);
});

it("retains a timed-out child's profile while a descendant can still write", async () => {
  const { run, marker } = await fixture(`
const {spawn}=await import('node:child_process');
const {join}=await import('node:path');
const writer=join(profile,'writer.mjs');
await writeFile(writer,\`import {writeFile} from 'node:fs/promises';
setTimeout(async()=>{await writeFile(process.env.PROOF_PROFILE+'/late-write','done');},2300);\`);
spawn(process.execPath,[writer],{stdio:'ignore'}).unref();
setInterval(()=>{},1000);`);
  await expect(run()).rejects.toThrow("Fixture proof exceeded 2000ms");
  const { profile } = JSON.parse(await readFile(marker, "utf8"));
  fixtures.push(dirname(profile));
  await access(profile);
  await vi.waitFor(async () => expect(await readFile(join(profile, "late-write"), "utf8")).toBe("done"), { timeout: 2_000 });
});
