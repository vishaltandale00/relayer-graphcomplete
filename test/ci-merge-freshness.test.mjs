import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CHECK_NAME, STATUS_CONTEXT, WINDOW_MS, decodeReceipt, evaluateEvidence, recordEvidence, sweep } from "../scripts/ci/merge-freshness.mjs";
import { evaluateDesktopReleaseAuthority } from "../scripts/audit-desktop-release-authority.mjs";

const head = "a".repeat(40), base = "b".repeat(40), merged = "c".repeat(40);
const repository = "owner/repo";
const started = Date.parse("2026-09-28T00:00:00Z");
function fixture() {
  return {
    repository, now: started + 1000,
    pr: { number: 42, state: "open", mergeable: true, head: { sha: head }, base: { ref: "main", sha: base, repo: { full_name: repository } } },
    run: { id: 10, run_attempt: 1, event: "pull_request", path: ".github/workflows/ci.yml", repository: { full_name: repository }, head_sha: head, status: "completed", conclusion: "success", created_at: new Date(started).toISOString() },
    jobs: [{ name: "check", head_sha: head, status: "completed", conclusion: "success" }],
    receipt: { version: 1, repository, pr: 42, runId: 10, attempt: 1, headSha: head, baseSha: base, mergeSha: merged, observedMain: base },
    merge: { sha: merged, parents: [{ sha: base }, { sha: head }] },
  };
}

function fakeGitHub(f) {
  const api = { rest: { pulls: {}, actions: {}, checks: {}, repos: {}, git: {} } };
  const outputs = [];
  const statuses = [];
  api.rest.pulls.list = async () => {};
  api.rest.repos.listCommitStatusesForRef = async () => {};
  api.rest.repos.createCommitStatus = async (args) => { statuses.unshift(args); return { data: args }; };
  api.rest.pulls.get = async () => ({ data: structuredClone(f.pr) });
  api.rest.actions.listWorkflowRuns = async () => {};
  api.rest.actions.listJobsForWorkflowRunAttempt = async () => {};
  api.rest.actions.listWorkflowRunArtifacts = async () => {};
  api.rest.actions.downloadArtifact = async () => ({ data: f.receipt });
  api.rest.git.getCommit = async () => ({ data: f.merge });
  api.rest.checks.create = async (args) => { outputs.push(args); return { data: { id: outputs.length } }; };
  api.rest.checks.update = async (args) => { outputs.push(args); };
  api.paginate = async (method, args) => {
    expect(args.per_page).toBe(100);
    if (method === api.rest.pulls.list) return [f.pr];
    if (method === api.rest.repos.listCommitStatusesForRef) {
      expect(args.ref).toBe(f.pr.head.sha);
      return statuses;
    }
    if (method === api.rest.actions.listWorkflowRuns) {
      expect(args).toMatchObject({ workflow_id: "ci.yml", head_sha: head, event: "pull_request" });
      return [{ ...f.run, pull_requests: [{ number: 42, head: { sha: head } }] }];
    }
    if (method === api.rest.actions.listJobsForWorkflowRunAttempt) {
      expect(args.attempt_number).toBe(f.run.run_attempt);
      return f.jobs;
    }
    if (method === api.rest.actions.listWorkflowRunArtifacts)
      return [{ id: 20, name: `merge-freshness-v1-${f.receipt.attempt}`, expired: false, size_in_bytes: 512 }];
    throw new Error("Unexpected endpoint");
  };
  return { api, outputs, statuses, options: { github: api, owner: "owner", repo: "repo", clock: () => f.now, decode: async (data) => data } };
}

describe("scheduled merge freshness", () => {
  it.each([false, true])("records the actual main merge with a stale event base=%s", async (staleEventBase) => {
    const directory = await mkdtemp(join(tmpdir(), "freshness-git-"));
    const git = (args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      git(["init", "-b", "main"]);
      git(["config", "user.name", "Fixture"]);
      git(["config", "user.email", "fixture@example.invalid"]);
      git(["config", "commit.gpgsign", "false"]);
      git(["commit", "--allow-empty", "-m", "main"]);
      const eventBaseSha = git(["rev-parse", "HEAD"]);
      git(["checkout", "-b", "pr"]);
      git(["commit", "--allow-empty", "-m", "head"]);
      const headSha = git(["rev-parse", "HEAD"]);
      if (staleEventBase) {
        git(["checkout", "main"]);
        git(["commit", "--allow-empty", "-m", "main advances after event base captured"]);
      }
      const currentMainSha = git(["rev-parse", "main"]);
      git(["checkout", "--detach", "main"]);
      git(["merge", "--no-ff", "pr", "-m", "test merge"]);
      const mergeSha = git(["rev-parse", "HEAD"]);
      git(["remote", "add", "origin", directory]);
      const f = fixture();
      f.pr.base.sha = eventBaseSha; f.pr.head.sha = headSha;
      const env = { GITHUB_SHA: mergeSha, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: "10", GITHUB_RUN_ATTEMPT: "1" };
      expect(recordEvidence({ pull_request: f.pr }, env, git)).toEqual({
        ...f.receipt, baseSha: currentMainSha, headSha, mergeSha, observedMain: currentMainSha,
      });
      expect(() => recordEvidence({ pull_request: { ...f.pr, head: { sha: currentMainSha } } }, env, git))
        .toThrow("exact main + PR merge");
      expect(() => recordEvidence({ pull_request: f.pr }, { ...env, GITHUB_SHA: headSha }, git))
        .toThrow("exact main + PR merge");
      git(["checkout", "main"]);
      git(["commit", "--allow-empty", "-m", "main advances beyond checkout"]);
      git(["checkout", "--detach", mergeSha]);
      expect(() => recordEvidence({ pull_request: f.pr }, env, git)).toThrow("observed main");
      git(["checkout", "pr"]);
      expect(() => recordEvidence({ pull_request: f.pr }, env, git)).toThrow("exact main + PR merge");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("permits newer main while evidence is fresh, and expires exactly at 12 hours", () => {
    const f = fixture();
    f.pr.base.sha = "d".repeat(40);
    f.now = started + WINDOW_MS - 1;
    expect(evaluateEvidence(f).conclusion).toBe("success");
    f.now += 1;
    expect(evaluateEvidence(f).conclusion).toBe("failure");
    f.run.run_attempt = f.receipt.attempt = 2;
    f.run.run_started_at = new Date(f.now).toISOString();
    expect(evaluateEvidence(f).conclusion).toBe("failure");
  });

  it.each([
    ["future clock", (f) => { f.now = started - 1; }],
    ["invalid timestamp", (f) => { f.run.created_at = "invalid"; }],
    ["other head", (f) => { f.run.head_sha = "d".repeat(40); }],
    ["other workflow", (f) => { f.run.path = ".github/workflows/other.yml"; }],
    ["other repository", (f) => { f.run.repository.full_name = "other/repo"; }],
    ["push CI", (f) => { f.run.event = "push"; }],
    ["new run pending", (f) => { f.run.status = "in_progress"; }],
    ["failed CI", (f) => { f.run.conclusion = "failure"; }],
    ["skipped check", (f) => { f.jobs[0].conclusion = "skipped"; }],
    ["missing check", (f) => { f.jobs = []; }],
    ["missing receipt", (f) => { f.receipt = undefined; }],
    ["future attempt", (f) => { f.receipt.attempt = 2; }],
    ["invalid attempt", (f) => { f.receipt.attempt = 0; }],
    ["wrong PR", (f) => { f.receipt.pr = 99; }],
    ["wrong run", (f) => { f.receipt.runId = 99; }],
    ["wrong receipt head", (f) => { f.receipt.headSha = base; }],
    ["unobserved main", (f) => { f.receipt.observedMain = head; }],
    ["wrong merge parents", (f) => { f.merge.parents.reverse(); }],
    ["invalid SHA", (f) => { f.receipt.mergeSha = "../../secret"; }],
    ["conflicts", (f) => { f.pr.mergeable = false; }],
    ["unknown mergeability", (f) => { f.pr.mergeable = null; }],
    ["closed PR", (f) => { f.pr.state = "closed"; }],
    ["retargeted PR", (f) => { f.pr.base.ref = "integration/train"; }],
  ])("rejects %s", (_label, mutate) => {
    const f = fixture(); mutate(f);
    expect(evaluateEvidence(f).conclusion).toBe("failure");
  });

  it("verifies a fork run with an empty PR association through its exact source and receipt", async () => {
    const f = fixture(), fake = fakeGitHub(f);
    f.pr.head = { sha: head, ref: "patch-retries", repo: { id: 123, full_name: "fork/repo" } };
    const run = { ...f.run, pull_requests: [], head_branch: "patch-retries",
      head_repository: { id: 123, full_name: "fork/repo" } };
    const paginate = fake.api.paginate;
    let runs = [run];
    fake.api.paginate = async (method, args) => method === fake.api.rest.actions.listWorkflowRuns
      ? runs : paginate(method, args);
    expect((await sweep(fake.options))[0].conclusion).toBe("success");
    for (const candidate of [
      { ...run, head_branch: "another-branch" },
      { ...run, head_repository: { id: 456, full_name: "other/repo" } },
      { ...run, head_repository: null },
      { ...run, head_repository: { id: 123, full_name: "other/repo" } },
      { ...run, pull_requests: [{ number: 99, head: { sha: head } }] },
    ]) {
      runs = [candidate];
      expect((await sweep(fake.options))[0].conclusion).toBe("failure");
    }
    runs = [{ ...run, id: 11, status: "in_progress", conclusion: null }, run];
    expect((await sweep(fake.options))[0].conclusion).toBe("failure");
    runs = [run];
    for (const fullName of [undefined, ""]) {
      f.pr.head.repo.full_name = run.head_repository.full_name = fullName;
      expect((await sweep(fake.options))[0].conclusion).toBe("failure");
    }
    f.pr.head.repo.full_name = run.head_repository.full_name = "fork/repo";
    f.receipt.pr = 99;
    expect((await sweep(fake.options))[0].conclusion).toBe("failure");
  });

  it("sweeps a current PR through success, expiration, and renewed CI", async () => {
    const f = fixture(), fake = fakeGitHub(f);
    expect((await sweep(fake.options))[0].conclusion).toBe("success");
    expect(fake.outputs[0]).toMatchObject({ name: CHECK_NAME, head_sha: head, status: "in_progress" });
    f.now = started + WINDOW_MS;
    expect((await sweep(fake.options))[0].conclusion).toBe("failure");
    f.run.id = f.receipt.runId = 11;
    f.run.created_at = new Date(f.now - 1000).toISOString();
    expect((await sweep(fake.options))[0].conclusion).toBe("success");
  });

  it("revokes a closed PR before listing open PRs, so a later PR cannot inherit success", async () => {
    const f = fixture(), fake = fakeGitHub(f), paginate = fake.api.paginate;
    expect((await sweep(fake.options))[0].conclusion).toBe("success");
    f.pr.state = "closed";
    fake.api.paginate = async (method, args) => {
      if (method === fake.api.rest.pulls.list) {
        expect(fake.statuses[0].state).toBe("failure");
        return [];
      }
      return paginate(method, args);
    };
    expect((await sweep({ ...fake.options, pullNumber: 42 }))[0]).toMatchObject({ conclusion: "failure", published: true });
    expect(fake.outputs.at(-1).conclusion).toBe("failure");
    // The same SHA is reused by a later PR without its own receipt.
    f.pr.number = 99; f.pr.state = "open";
    fake.api.paginate = paginate;
    expect(fake.statuses[0].state).toBe("failure");
    expect((await sweep(fake.options))[0].conclusion).toBe("failure");
  });

  it("revokes a closed event head even if the open-PR listing subsequently fails", async () => {
    const f = fixture(), fake = fakeGitHub(f), paginate = fake.api.paginate;
    await sweep(fake.options);
    f.pr.state = "closed";
    fake.api.paginate = async (method, args) => {
      if (method === fake.api.rest.pulls.list) throw new Error("list unavailable");
      return paginate(method, args);
    };
    await expect(sweep({ ...fake.options, pullNumber: 42 })).rejects.toThrow("list unavailable");
    expect(fake.statuses[0].state).toBe("failure");
    expect(fake.outputs.at(-1).conclusion).toBe("failure");
  });

  it("revokes a PR retargeted away from main even when open-main listing fails", async () => {
    const f = fixture(), fake = fakeGitHub(f), paginate = fake.api.paginate;
    await sweep(fake.options);
    f.pr.base.ref = "integration/train";
    fake.api.paginate = async (method, args) => {
      if (method === fake.api.rest.pulls.list) throw new Error("list unavailable");
      return paginate(method, args);
    };
    await expect(sweep({ ...fake.options, pullNumber: 42 })).rejects.toThrow("list unavailable");
    expect(fake.statuses[0]).toMatchObject({ state: "failure", sha: head });
    expect(fake.outputs.at(-1).conclusion).toBe("failure");
  });

  it("selects the current PR's latest run even when other PRs share its head SHA", async () => {
    const f = fixture(), fake = fakeGitHub(f), paginate = fake.api.paginate;
    const ownRun = { ...f.run, pull_requests: [{ number: 42, head: { sha: head } }] };
    const unrelated = { ...f.run, id: 12, pull_requests: [{ number: 99, head: { sha: head } }] };
    let runs = [unrelated, ownRun];
    fake.api.paginate = async (method, args) => method === fake.api.rest.actions.listWorkflowRuns
      ? runs : paginate(method, args);
    expect((await sweep(fake.options))[0].conclusion).toBe("success");
    // Do not fall back to an older success when this PR has a newer pending run.
    runs = [unrelated, { ...ownRun, id: 11, status: "in_progress" }, ownRun];
    expect((await sweep(fake.options))[0].conclusion).toBe("failure");
    runs = [unrelated];
    expect((await sweep(fake.options))[0].conclusion).toBe("failure");
  });

  it("accepts a failed-jobs rerun's original plan receipt without renewing its expiry", async () => {
    const f = fixture(), fake = fakeGitHub(f);
    f.run.run_attempt = 2;
    expect(f.receipt.attempt).toBe(1);
    expect((await sweep(fake.options))[0].conclusion).toBe("success");
    f.now = started + WINDOW_MS;
    expect((await sweep(fake.options))[0].conclusion).toBe("failure");
  });

  it.each([false, true])("rejects shared heads regardless of PR ordering (reverse=%s)", async (reverse) => {
    const f = fixture(), fake = fakeGitHub(f), paginate = fake.api.paginate;
    const other = { ...structuredClone(f.pr), number: 99 };
    const prs = reverse ? [other, f.pr] : [f.pr, other];
    fake.api.paginate = async (method, args) => method === fake.api.rest.pulls.list
      ? prs : paginate(method, args);
    fake.api.rest.pulls.get = async ({ pull_number }) => ({ data: structuredClone(prs.find((pr) => pr.number === pull_number)) });
    const results = await sweep(fake.options);
    expect(results.every((result) => result.conclusion === "failure")).toBe(true);
    expect(fake.statuses.some((status) => status.state === "success")).toBe(false);
    expect(fake.outputs.some((check) => check.conclusion === "success")).toBe(false);
  });

  it("rechecks shared heads after evidence IO and fails closed when the check is unavailable", async () => {
    for (const unavailable of [false, true]) {
      const f = fixture(), fake = fakeGitHub(f), paginate = fake.api.paginate;
      let calls = 0;
      fake.api.paginate = async (method, args) => {
        if (method !== fake.api.rest.pulls.list || ++calls === 1) return paginate(method, args);
        expect(fake.statuses[0].state).toBe("pending");
        if (unavailable) throw new Error("API unavailable");
        return [f.pr, { ...f.pr, number: 99 }];
      };
      expect((await sweep(fake.options))[0].conclusion).toBe("failure");
      expect(fake.statuses[0].state).toBe("failure");
    }
  });

  it("revokes success before evidence failure and rejects a head change during IO", async () => {
    const f = fixture(), fake = fakeGitHub(f);
    fake.api.rest.actions.downloadArtifact = async () => { throw new Error("untrusted secret error"); };
    expect((await sweep(fake.options))[0].description).toBe("Freshness evidence unavailable; retry the guard");
    expect(fake.outputs.map((o) => o.status)).toEqual(["in_progress", "completed"]);
    fake.api.rest.actions.downloadArtifact = async () => {
      f.pr.head.sha = "e".repeat(40);
      return { data: f.receipt };
    };
    expect((await sweep(fake.options))[0].description).toBe("PR head changed during evaluation");
    expect(fake.outputs.at(-1).conclusion).toBe("failure");
    expect(fake.statuses[0]).toMatchObject({ state: "failure", sha: head });
  });

  it.each(["get", "create", "update"])("continues after one PR's %s failure and reports unpublished results", async (failureAt) => {
    const f = fixture(), fake = fakeGitHub(f);
    const paginate = fake.api.paginate;
    fake.api.paginate = async (method, args) => method === fake.api.rest.pulls.list
      ? [{ number: 41 }, f.pr] : paginate(method, args);
    const get = fake.api.rest.pulls.get;
    fake.api.rest.pulls.get = async (args) => {
      if (args.pull_number === 41) {
        if (failureAt === "get") throw new Error("sensitive API error");
        return { data: { ...f.pr, number: 41 } };
      }
      return get(args);
    };
    if (failureAt !== "get") {
      const original = fake.api.rest.checks[failureAt];
      let first = true;
      fake.api.rest.checks[failureAt] = async (args) => {
        if (first) { first = false; throw new Error("sensitive API error"); }
        return original(args);
      };
    }
    // The second PR had a previous success, but its evidence has now expired.
    f.now = started + WINDOW_MS;
    const results = await sweep(fake.options);
    expect(results).toEqual([
      { pr: 41, conclusion: "failure", published: false, description: "Freshness check could not be refreshed; retry the guard" },
      { pr: 42, conclusion: "failure", published: true, description: "CI evidence expired (12h); update branch and run fresh PR CI" },
    ]);
    expect(fake.outputs.at(-1)).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("publishes the required commit status independently of successive workflow suites", async () => {
    const f = fixture(), fake = fakeGitHub(f);
    // GitHub can attach every API-created check to the first suite even after
    // another PR edit creates the newer suite selected by the merge box.
    const create = fake.api.rest.checks.create;
    fake.api.rest.checks.create = async (args) => ({
      data: { ...(await create(args)).data, check_suite: { id: 1 } },
    });
    for (let refresh = 0; refresh < 2; refresh++) {
      expect((await sweep(fake.options))[0].conclusion).toBe("success");
      expect(fake.statuses.slice(0, 2)).toMatchObject([
        { context: STATUS_CONTEXT, sha: head, state: "success" },
        { context: STATUS_CONTEXT, sha: head, state: "pending" },
      ]);
    }
    expect(STATUS_CONTEXT).not.toBe(CHECK_NAME);
    f.now = started + WINDOW_MS;
    expect((await sweep(fake.options))[0].conclusion).toBe("failure");
    expect(fake.statuses[0]).toMatchObject({ state: "failure", context: STATUS_CONTEXT, sha: head });
  });

  it("revokes both publications even when one revocation fails", async () => {
    for (const failedPublisher of ["check", "status"]) {
      const f = fixture(), fake = fakeGitHub(f);
      await sweep(fake.options);
      if (failedPublisher === "check") fake.api.rest.checks.create = async () => { throw new Error("unavailable"); };
      else fake.api.rest.repos.createCommitStatus = async () => { throw new Error("unavailable"); };
      expect((await sweep(fake.options))[0].published).toBe(false);
      if (failedPublisher === "check") expect(fake.statuses[0].state).toBe("pending");
      else expect(fake.outputs.at(-1).status).toBe("in_progress");
    }
  });

  it("attempts both final publications and retains pending when a final write fails", async () => {
    for (const failedPublisher of ["check", "status"]) {
      const f = fixture(), fake = fakeGitHub(f);
      await sweep(fake.options);
      f.now = started + WINDOW_MS;
      if (failedPublisher === "check") fake.api.rest.checks.update = async () => { throw new Error("unavailable"); };
      else {
        const publish = fake.api.rest.repos.createCommitStatus;
        fake.api.rest.repos.createCommitStatus = async (args) => {
          if (args.state !== "pending") throw new Error("unavailable");
          return publish(args);
        };
      }
      expect((await sweep(fake.options))[0].published).toBe(false);
      expect(fake.statuses[0].state).toBe(failedPublisher === "status" ? "pending" : "failure");
      expect(fake.outputs.at(-1)).toMatchObject(failedPublisher === "check"
        ? { status: "in_progress" } : { status: "completed", conclusion: "failure" });
    }
  });

  it("reserves status capacity for failure and revokes before a status-history read error", async () => {
    const f = fixture(), fake = fakeGitHub(f);
    // GitHub contexts are case-insensitive, including their capacity limit.
    fake.statuses.push(...Array.from({ length: 989 }, () => ({ context: STATUS_CONTEXT.toUpperCase(), state: "success" })));
    expect((await sweep(fake.options))[0]).toMatchObject({
      conclusion: "failure", description: "Freshness status capacity exhausted; update branch to a new head",
    });
    expect(fake.statuses[0].state).toBe("failure");
    expect(fake.outputs.at(-1).conclusion).toBe("failure");
    const publish = fake.api.rest.repos.createCommitStatus;
    fake.api.rest.repos.createCommitStatus = async (args) => {
      if (fake.statuses.length >= 1000) throw new Error("status limit reached");
      return publish(args);
    };
    for (let refresh = 0; refresh < 6; refresh++) await sweep(fake.options);
    expect(fake.statuses).toHaveLength(1000);
    expect(fake.statuses[0].state).toBe("pending");
    expect(fake.statuses.slice(0, 11).every((item) => item.state !== "success")).toBe(true);
    const other = fakeGitHub(f);
    other.api.paginate = async (method) => {
      if (method === other.api.rest.pulls.list) return [f.pr];
      expect(other.statuses[0].state).toBe("pending");
      throw new Error("sensitive status history error");
    };
    expect((await sweep(other.options))[0].conclusion).toBe("failure");
    expect(other.statuses[0].state).toBe("failure");
  });

  it("reads only bounded literal JSON from a real ZIP and rejects malformed archives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "freshness-test-"));
    try {
      const file = join(directory, "freshness.json"), archive = join(directory, "receipt.zip");
      await writeFile(file, JSON.stringify(fixture().receipt));
      execFileSync("zip", ["-q", archive, "freshness.json"], { cwd: directory });
      expect(await decodeReceipt(await readFile(archive))).toEqual(fixture().receipt);
      await expect(decodeReceipt(Buffer.alloc(65537))).rejects.toThrow("too large");
      await expect(decodeReceipt(Buffer.from("invalid"))).rejects.toThrow();
      // Exceed OS pipe capacity while keeping the compressed archive within the
      // input bound. Isolate synchronous unzip so a termination regression cannot
      // hang the test worker; kill the whole process group on an outer deadline.
      await writeFile(file, "x".repeat(1024 * 1024));
      execFileSync("zip", ["-q", archive, "freshness.json"], { cwd: directory });
      expect((await readFile(archive)).byteLength).toBeLessThan(64 * 1024);
      const decoder = new URL("../scripts/ci/merge-freshness.mjs", import.meta.url).href;
      const code = `import { readFile } from 'node:fs/promises';
        import { decodeReceipt } from ${JSON.stringify(decoder)};
        try { await decodeReceipt(await readFile(process.argv[1])); process.exitCode = 1; }
        catch (error) { if (error.code !== 'ENOBUFS' && error.code !== 'ETIMEDOUT') throw error; }`;
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", code, archive], {
          detached: true, stdio: "ignore",
        });
        const timeout = setTimeout(() => {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
          reject(new Error("Oversized ZIP decoder did not terminate within seven seconds"));
        }, 7000);
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error(`ZIP decoder exited ${code ?? signal}`));
        });
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("binds scheduled write authority to main and keeps CI plus freshness required", async () => {
    const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const workflow = parse(await read(".github/workflows/merge-freshness.yml"));
    expect(workflow.on.schedule).toEqual([{ cron: "7,22,37,52 * * * *" }]);
    expect(workflow.on.workflow_run).toEqual({ workflows: ["CI"], types: ["completed"] });
    expect(workflow.on.pull_request_target.types).toContain("closed");
    expect(workflow.on.pull_request_target.branches).toBeUndefined();
    expect(workflow.concurrency).toEqual({ group: "merge-freshness-writer", "cancel-in-progress": false });
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read", checks: "write", statuses: "write" });
    expect(workflow.jobs.refresh.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.refresh.steps[0].with).toEqual({ ref: "refs/heads/main", "persist-credentials": false });
    expect(workflow.jobs.refresh.steps).toHaveLength(2);
    for (const step of workflow.jobs.refresh.steps) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    expect(workflow.jobs.refresh.steps[1].with.script).toContain("result.published === false");
    expect(workflow.jobs.refresh.steps[1].with.script).toContain("pullNumber: context.payload.pull_request?.number");
    expect(workflow.jobs.refresh.steps[1].with.script).toContain("core.setFailed(");
    const ci = parse(await read(".github/workflows/ci.yml"));
    for (const job of Object.values(ci.jobs)) {
      if (job.if === "${{ false }}" || job.if === false) continue;
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout@")) expect(step.with.ref).toBe("${{ github.sha }}");
      }
    }
    for (const name of ["Record exact main and PR merge tested by CI", "Upload merge freshness evidence"]) {
      expect(ci.jobs.plan.steps.find((step) => step.name === name)["continue-on-error"]).toBe(true);
    }
    expect(ci.jobs.plan.steps.find((step) => step.name === "Upload merge freshness evidence").with.name).toBe("merge-freshness-v1-${{ github.run_attempt }}");
    const main = JSON.parse(await read("infra/github/desktop-release-authority/main-ruleset.json"));
    const checks = main.rules.find((rule) => rule.type === "required_status_checks").parameters;
    expect(checks.strict_required_status_checks_policy).toBe(false);
    expect(checks.required_status_checks).toEqual([
      { context: "check", integration_id: 15368 }, { context: STATUS_CONTEXT, integration_id: 15368 },
    ]);
    const label = "main requires GitHub Actions CI and scheduled merge freshness";
    const rulesets = [main];
    const audit = () => evaluateDesktopReleaseAuthority({ rulesets }).find((item) => item.label === label).passed;
    expect(audit()).toBe(true);
    checks.required_status_checks.push({ context: CHECK_NAME, integration_id: 15368 });
    expect(audit()).toBe(false);
    checks.required_status_checks.pop();
    rulesets.push({ ...main, rules: [{ type: "required_status_checks", parameters: {
      required_status_checks: [{ context: CHECK_NAME.toUpperCase(), integration_id: 15368 }],
    } }] });
    expect(audit()).toBe(false);
    rulesets.pop();
    checks.required_status_checks.push({ context: "unrelated-protection", integration_id: 15368 });
    expect(audit()).toBe(true);
    checks.required_status_checks.pop();
    checks.required_status_checks.pop();
    expect(audit()).toBe(false);
  });
});
