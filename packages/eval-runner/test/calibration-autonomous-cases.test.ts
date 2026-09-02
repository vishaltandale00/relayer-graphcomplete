import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  calibrationAutonomousCaseIds,
  calibrationAutonomousCases,
  gradeCalibrationWorkspace,
  materializeCalibrationFixture,
  type CalibrationCaseId,
} from "../src/project-cases/calibration-autonomous-cases.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("deep calibration candidate cases", () => {
  it("publishes seven coding and five general-interest work cases", () => {
    expect([...calibrationAutonomousCaseIds]).toHaveLength(12);
    expect(calibrationAutonomousCases.filter(({ snapshot }) => snapshot.category === "coding")).toHaveLength(7);
    expect(calibrationAutonomousCases.filter(({ snapshot }) => snapshot.category === "work")).toHaveLength(5);
    expect(calibrationAutonomousCases.filter(({ definition }) => definition.taskType === "greenfield-build")).toHaveLength(3);
    expect(calibrationAutonomousCases.every(({ snapshot }) => snapshot.authoringStatus === "candidate")).toBe(true);
    expect(calibrationAutonomousCases.every(({ definition }) => definition.threads[0]?.prompts.length === 1)).toBe(true);
  });

  it("keeps terse prompts and sealed paths out of the public catalog", () => {
    for (const entry of calibrationAutonomousCases) {
      const prompt = entry.definition.threads[0]?.prompts[0] ?? "";
      expect(prompt.length).toBeLessThan(900);
      expect(prompt).not.toMatch(/layer|graph|node|rubric|verifier/i);
      expect(entry.catalogSnapshot.artifacts.reference).not.toHaveProperty("sealedPath");
      expect(entry.catalogSnapshot.artifacts.verifier).not.toHaveProperty("sealedPath");
    }
  });

  it("rejects calibration fixture execution outside the declared local Mac environment", async () => {
    await expect(materializeCalibrationFixture({
      caseId: "calibration.greenfield.json-explorer",
      workspaceDirectory: "/unused/calibration-workspace",
      platform: "linux",
    })).rejects.toThrow("Calibration cases are local Mac only");
  });

  it("materializes an immutable baseline repository through the production seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-calibration-case-"));
    temporaryDirectories.push(root);
    const workspaceDirectory = join(root, "workspace");
    const fixture = await materializeCalibrationFixture({
      caseId: "calibration.greenfield.json-explorer",
      workspaceDirectory,
      platform: "darwin",
    });

    expect(fixture).toMatchObject({
      fixtureId: "calibration.greenfield.json-explorer",
      workspaceDirectory,
      sourceRevision: expect.stringMatching(/^template:sha256:/),
      seededCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
      seededTree: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(await readFile(join(workspaceDirectory, "README.md"), "utf8")).toContain("JSON Explorer");
    expect(await readFile(join(workspaceDirectory, ".git/config"), "utf8")).toMatch(/\[commit\][\s\S]*gpgsign = false/);
    expect(await readFile(join(workspaceDirectory, ".git/config"), "utf8")).toMatch(/fsmonitor = false/);
  });

  it("fails an untouched baseline without confusing verifier completion with qualification", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-calibration-grade-"));
    temporaryDirectories.push(root);
    const workspaceDirectory = join(root, "workspace");
    const fixture = await materializeCalibrationFixture({
      caseId: "calibration.research.rome-transition",
      workspaceDirectory,
      platform: "darwin",
    });
    const checks = await gradeCalibrationWorkspace({
      caseId: "calibration.research.rome-transition",
      workspaceDirectory,
      baseRevision: fixture.seededCommit,
    });

    expect(checks.find(({ name }) => name === "workspace:required-deliverables")?.passed).toBe(false);
    expect(checks.find(({ name }) => name === "workspace:delivery-commit")?.passed).toBe(false);
  });

  it("leaves every coding baseline behaviorally unsolved", async () => {
    const coding = calibrationAutonomousCases.filter(({ snapshot }) => snapshot.category === "coding");
    for (const { definition } of coding) {
      const root = await mkdtemp(join(tmpdir(), "relayer-calibration-red-"));
      temporaryDirectories.push(root);
      const workspaceDirectory = join(root, "workspace");
      const fixture = await materializeCalibrationFixture({ caseId: definition.id, workspaceDirectory, platform: "darwin" });
      const checks = await gradeCalibrationWorkspace({ caseId: definition.id, workspaceDirectory, baseRevision: fixture.seededCommit });
      expect(checks.find(({ name }) => name === "workspace:behavior-or-structure"), definition.id).toMatchObject({ passed: false });
    }
  }, 20_000);

  it("gives the cross-cutting debugging cases inspectable responsibility seams", async () => {
    const expectedFiles: Partial<Readonly<Record<CalibrationCaseId, readonly string[]>>> = {
      "calibration.debugging.stale-result-race": [
        "src/refresh-coordinator.js",
        "src/result-store.js",
        "src/result-view.js",
      ],
      "calibration.security.credential-leak": [
        "src/proxy-config.js",
        "src/transport.js",
        "src/debug-proxy.js",
        "src/safe-error.js",
      ],
    };

    for (const [caseId, relativePaths] of Object.entries(expectedFiles)) {
      const root = await mkdtemp(join(tmpdir(), "relayer-calibration-depth-"));
      temporaryDirectories.push(root);
      const workspaceDirectory = join(root, "workspace");
      await materializeCalibrationFixture({ caseId: caseId as CalibrationCaseId, workspaceDirectory, platform: "darwin" });
      for (const relativePath of relativePaths) {
        expect((await readFile(join(workspaceDirectory, relativePath), "utf8")).trim(), `${caseId}:${relativePath}`).not.toBe("");
      }
    }
  }, 20_000);

  it("accepts one known-good implementation for every coding verifier", async () => {
    const solutions: Readonly<Record<string, string>> = {
      "calibration.greenfield.json-explorer": `const esc=(v)=>String(v).replaceAll('~','~0').replaceAll('/','~1');
export function parseJson(text){try{return {ok:true,value:JSON.parse(text)}}catch(error){return {ok:false,error:String(error.message)}}}
export function searchJson(value,query){const out=[],needle=String(query).toLowerCase(); const visit=(v,p)=>{if(v!==null&&typeof v==='object'){for(const key of Object.keys(v)){const next=p+'/'+esc(key); if(typeof v[key]!=='object'&&String(v[key]).toLowerCase().includes(needle))out.push(next); visit(v[key],next)}}}; visit(value,''); return out.sort()}
export function diffJson(left,right){const out=[]; const walk=(a,b,p)=>{if(Object.is(a,b))return; if(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort((x,y)=>Number.isFinite(+x)&&Number.isFinite(+y)?+x-+y:x.localeCompare(y))){const path=p+'/'+esc(key); if(!(key in a))out.push({path,kind:'added',after:b[key]}); else if(!(key in b))out.push({path,kind:'removed',before:a[key]}); else walk(a[key],b[key],path)}; return} out.push({path:p||'/',kind:'changed',before:a,after:b})}; walk(left,right,''); return out}
`,
      "calibration.greenfield.local-trip-board": `const rebuild=(board)=>{const items=[]; for(const edit of board.edits){if(edit.type==='add'&&!items.some(x=>x.id===edit.item.id))items.push(structuredClone(edit.item)); if(edit.type==='remove'){const i=items.findIndex(x=>x.id===edit.itemId); if(i>=0)items.splice(i,1)}} return {...board,items:items.sort((a,b)=>a.id.localeCompare(b.id))}}
export const createBoard=(actorId)=>({actorId,edits:[],items:[]});
export const applyEdit=(board,edit)=>rebuild({...board,edits:[...board.edits.filter(x=>x.id!==edit.id),structuredClone(edit)].sort((a,b)=>a.id.localeCompare(b.id))});
export const mergeBoards=(left,right)=>rebuild({actorId:left.actorId,edits:[...new Map([...left.edits,...right.edits].map(x=>[x.id,x])).values()].sort((a,b)=>a.id.localeCompare(b.id)),items:[]});
export const undo=(board,actorId)=>{const own=board.edits.filter(x=>x.actorId===actorId).sort((a,b)=>b.sequence-a.sequence)[0]; return own?rebuild({...board,edits:board.edits.filter(x=>x.id!==own.id)}):board};
export const serializeBoard=(board)=>JSON.stringify(board); export const deserializeBoard=(text)=>JSON.parse(text);
`,
      "calibration.greenfield.podcast-workspace": `export const searchTranscript=(segments,query)=>segments.filter(x=>x.text.toLowerCase().includes(String(query).toLowerCase()));
export function createClip(segments,startMs,endMs){if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<0||endMs<=startMs)throw Error('invalid clip'); const selected=segments.filter(x=>x.endMs>startMs&&x.startMs<endMs); if(!selected.length)throw Error('empty clip'); return {id:startMs+'-'+endMs,startMs,endMs,text:selected.map(x=>x.text).join(' ')}}
export const createPlaylist=(title)=>({title,clips:[]}); export const addClip=(playlist,clip)=>({...playlist,clips:[...playlist.clips,clip]});
export const exportWorkspace=(value)=>JSON.stringify(value); export const importWorkspace=(text)=>JSON.parse(text);
`,
      "calibration.feature.resumable-uploads": `export class UploadStore{#files=new Map();#uploads=new Map();put(id,b){this.#files.set(id,Buffer.from(b))}get(id){const b=this.#files.get(id);return b&&Buffer.from(b)}begin(id,meta){this.#uploads.set(id,{meta,chunks:new Map()})}acceptChunk(id,n,b){const u=this.#uploads.get(id);if(!u)throw Error('missing upload');const bytes=Buffer.from(b),prior=u.chunks.get(n);if(prior&&!prior.equals(bytes))throw Error('conflict');u.chunks.set(n,bytes)}resumeState(id){const u=this.#uploads.get(id);return {received:[...u.chunks.keys()].sort((a,b)=>a-b),chunks:u.meta.chunks}}finalize(id){const u=this.#uploads.get(id);if(!u||u.chunks.size!==u.meta.chunks)throw Error('gaps');const b=Buffer.concat(Array.from({length:u.meta.chunks},(_,i)=>{const c=u.chunks.get(i);if(!c)throw Error('gap');return c}));this.#files.set(id,b);this.#uploads.delete(id);return b}cancel(id){this.#uploads.delete(id)}exportState(){return JSON.stringify({files:[...this.#files].map(([k,v])=>[k,v.toString('base64')]),uploads:[...this.#uploads].map(([k,u])=>[k,{meta:u.meta,chunks:[...u.chunks].map(([n,v])=>[n,v.toString('base64')])}])})}static fromState(text){const d=JSON.parse(text),s=new UploadStore();s.#files=new Map(d.files.map(([k,v])=>[k,Buffer.from(v,'base64')]));s.#uploads=new Map(d.uploads.map(([k,u])=>[k,{meta:u.meta,chunks:new Map(u.chunks.map(([n,v])=>[n,Buffer.from(v,'base64')]))}]));return s}}
`,
      "calibration.feature.readonly-collaborators": `export class ProjectAccess{#roles=new Map();#invites=new Map();constructor({ownerId}){this.#roles.set(ownerId,'owner')}#owner(id){if(this.#roles.get(id)!=='owner')throw Error('forbidden')}addEditor(a,u){this.#owner(a);this.#roles.set(u,'editor')}invite(a,email,role){this.#owner(a);if(role!=='viewer')throw Error('invalid role');const token='invite-'+this.#invites.size;const value={token,email,role};this.#invites.set(token,value);return value}accept(token,userId){const i=this.#invites.get(token);if(!i)throw Error('invalid invitation');this.#roles.set(userId,i.role);this.#invites.delete(token)}revoke(a,u){this.#owner(a);this.#roles.delete(u)}authorize(u,action){const r=this.#roles.get(u);if(r==='owner')return true;if(r==='editor')return action!=='delete';if(r==='viewer')return action==='read';return false}projection(u){return {role:this.#roles.get(u)??null,canWrite:this.authorize(u,'write')}}}
`,
      "calibration.debugging.stale-result-race": `export class ResultStore{#results=new Map();async publish(key,result){await Promise.resolve();const prior=this.#results.get(key);if(!prior||result.generation>prior.generation)this.#results.set(key,structuredClone(result))}read(key){const r=this.#results.get(key);return r&&structuredClone(r)}exportState(){return JSON.stringify([...this.#results])}static fromState(text){const s=new ResultStore();s.#results=new Map(JSON.parse(text));return s}}
export class RefreshCoordinator{#issued=new Map();constructor({store,run}){this.store=store;this.run=run}async refresh(key){const generation=Math.max(this.#issued.get(key)??0,this.store.read(key)?.generation??0)+1;this.#issued.set(key,generation);const result=await this.run(key,generation);await this.store.publish(key,{generation,value:result.value});return this.store.read(key)}}
export const resultView=(store,key)=>{const result=store.read(key);return result?{status:'ready',generation:result.generation,value:result.value}:{status:'empty'}};
`,
      "calibration.security.credential-leak": `const parsed=(value)=>new URL(value); export function proxyAuthorization(value){const u=parsed(value);return 'Basic '+Buffer.from(decodeURIComponent(u.username)+':'+decodeURIComponent(u.password)).toString('base64')} export function sanitizeUrl(value){const u=parsed(value);u.password='';return u.toString()} export function debugProxy(value){return 'Proxy('+sanitizeUrl(value)+')'} export function safeError(error){return new Error(String(error?.message??error).replace(/https?:\\/\\/[^\\s]+/g,(url)=>sanitizeUrl(url)))}
`,
    };

    for (const [caseId, implementation] of Object.entries(solutions)) {
      const typedCaseId = caseId as CalibrationCaseId;
      const root = await mkdtemp(join(tmpdir(), "relayer-calibration-solution-"));
      temporaryDirectories.push(root);
      const workspaceDirectory = join(root, "workspace");
      const fixture = await materializeCalibrationFixture({ caseId: typedCaseId, workspaceDirectory, platform: "darwin" });
      await writeFile(join(workspaceDirectory, "src/index.js"), implementation, "utf8");
      if (caseId.startsWith("calibration.greenfield.")) await writeFile(join(workspaceDirectory, "index.html"), "<!doctype html><title>Working calibration application</title>\n", "utf8");
      await execFileAsync("git", ["add", "--all"], { cwd: workspaceDirectory });
      await execFileAsync("git", ["commit", "--quiet", "-m", "Implement reference behavior"], { cwd: workspaceDirectory });
      const checks = await gradeCalibrationWorkspace({ caseId: typedCaseId, workspaceDirectory, baseRevision: fixture.seededCommit });
      expect(checks.every(({ passed }) => passed), `${caseId}: ${JSON.stringify(checks)}`).toBe(true);
    }
  }, 20_000);

  it("accepts structurally complete work artifacts without claiming semantic qualification", async () => {
    const sources = Array.from({ length: 5 }, (_, index) => ({
      title: `Source ${index + 1}`,
      url: `https://example.test/source-${index + 1}`,
      publisher: "Example",
      accessedAt: "2026-08-27",
    }));
    const workArtifacts: Readonly<Record<string, Readonly<Record<string, string>>>> = {
      "calibration.research.rome-transition": {
        "rome-briefing.md": "# Rome\n\n" + "A researched explanation. ".repeat(40),
        "sources.json": JSON.stringify(sources),
      },
      "calibration.research.humanoid-robots": {
        "humanoid-robots.md": "# Humanoid robots\n\n" + "A dated technical briefing. ".repeat(40),
        "sources.json": JSON.stringify(sources),
      },
      "calibration.planning.group-europe-trip": {
        "trip-plan.md": "# Trip\n\n" + "A coordinated plan. ".repeat(40),
        "sources.json": JSON.stringify(sources),
        "itineraries.json": JSON.stringify({ travelers: ["Maya", "Luis", "Priya", "Sam", "Jordan", "Vishal"].map((name) => ({ name, days: [{ date: "2027-09-11", city: "Paris", activities: ["Shared dinner"] }] })) }),
      },
      "calibration.creative.mystery-season": {
        "season-bible.md": "# The Last Guest\n\n" + "An original fair-play season. ".repeat(40),
        "episodes.json": JSON.stringify({
          culprit: "The archivist",
          motive: "To conceal the provenance of the collection",
          episodes: Array.from({ length: 8 }, (_, index) => ({ number: index + 1, title: `Episode ${index + 1}` })),
          clues: Array.from({ length: 5 }, (_, index) => ({ clue: `Clue ${index + 1}`, setupEpisode: index + 1, payoffEpisode: index + 3 })),
        }),
      },
      "calibration.forecasting.nfl-season": {
        "nfl-forecast.md": "# Forecast\n\n" + "A sourced team-by-team forecast. ".repeat(40),
        "sources.json": JSON.stringify(sources),
        "predictions.json": JSON.stringify({ teams: Array.from({ length: 32 }, (_, index) => ({
          team: `TEAM-${index + 1}`,
          division: `DIV-${Math.floor(index / 4) + 1}`,
          wins: index < 16 ? 9 : 8,
          losses: index < 16 ? 8 : 9,
          playoff: index < 14,
          reasoning: `Distinct evidence-grounded outlook for team ${index + 1}.`,
          uncertainty: "Medium",
        })) }),
      },
    };

    for (const [caseId, files] of Object.entries(workArtifacts)) {
      const typedCaseId = caseId as CalibrationCaseId;
      const root = await mkdtemp(join(tmpdir(), "relayer-calibration-green-"));
      temporaryDirectories.push(root);
      const workspaceDirectory = join(root, "workspace");
      const fixture = await materializeCalibrationFixture({ caseId: typedCaseId, workspaceDirectory, platform: "darwin" });
      for (const [relativePath, contents] of Object.entries(files)) {
        await mkdir(join(workspaceDirectory, relativePath, ".."), { recursive: true });
        await writeFile(join(workspaceDirectory, relativePath), `${contents}\n`, "utf8");
      }
      await execFileAsync("git", ["add", "--all"], { cwd: workspaceDirectory });
      await execFileAsync("git", ["commit", "--quiet", "-m", "Complete work artifact"], { cwd: workspaceDirectory });
      const checks = await gradeCalibrationWorkspace({ caseId: typedCaseId, workspaceDirectory, baseRevision: fixture.seededCommit });
      expect(checks.every(({ passed }) => passed), `${caseId}: ${JSON.stringify(checks)}`).toBe(true);
    }
  }, 20_000);
});
