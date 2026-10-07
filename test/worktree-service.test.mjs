import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, realpath, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { inspectFolder, inspectRepository, validateSelection, createWorktreeService } from '../desktop/main/services/worktree-service.mjs';
const roots = [];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim();
async function fixture() {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'relayer-worktrees-')));
    roots.push(root);
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Fixture');
    git(repo, 'config', 'user.email', 'fixture@example.invalid');
    git(repo, 'config', 'init.defaultBranch', 'main');
    await mkdir(path.join(repo, 'frontend'));
    await writeFile(path.join(repo, 'frontend', 'file'), 'first');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'initial');
    return {
        root, repo, service: createWorktreeService({
            worktreeRoot: path.join(root, 'managed'), storeDirectory: path.join(root, 'receipts')
        })
    };
}
afterEach(async () => {
    await Promise.all(roots.splice(0).map(x => rm(x, {
        recursive: true, force: true
    })));
});
describe('real Git worktree lifecycle', () => {
    test('unborn repository is Git but has no valid creation base', async () => {
        const { root, service } = await fixture();
        const repo = path.join(root, 'unborn');
        await mkdir(repo);
        git(repo, 'init', '-b', 'main');
        const info = await inspectRepository(repo);
        expect(info).toMatchObject({
            git: true, commit: null, bases: [], defaultBase: null
        });
        await expect(service.plan({
            repositoryPath: repo, base: 'checkout'
        })).rejects.toMatchObject({
            code: 'base-unavailable'
        });
    });
    test('detects linked/subfolder identity, dirty detached locked and missing inventory without mixing clones', async () => {
        const { root, repo } = await fixture();
        const linked = path.join(root, 'linked');
        git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
        git(repo, 'worktree', 'lock', '--reason', 'fixture', linked);
        await writeFile(path.join(linked, 'dirty'), 'dirty');
        const a = await inspectRepository(path.join(linked, 'frontend'));
        const b = await inspectFolder(repo);
        expect(a.repositoryId).toBe(b.repositoryId);
        expect(a.checkoutRoot).toBe(linked);
        expect(a.relativePath).toBe('frontend');
        expect(a.worktrees.find(x => x.path === linked)).toMatchObject({
            dirty: true, detached: true, locked: true, available: true
        });
        const clone = path.join(root, 'clone');
        git(root, 'clone', repo, clone);
        expect((await inspectFolder(clone)).repositoryId).not.toBe(a.repositoryId);
        const nested = path.join(repo, 'nested');
        await mkdir(nested); git(nested, 'init', '-b', 'nested');
        expect((await inspectFolder(nested)).repositoryId).not.toBe(a.repositoryId);
        const blocked = path.join(root, 'blocked');
        git(repo, 'worktree', 'add', '--detach', blocked, 'HEAD');
        await chmod(blocked, 0);
        try {
            expect((await inspectRepository(repo)).worktrees.find(x => x.path === blocked)).toMatchObject({ available: false, reason: 'inaccessible' });
        } finally { await chmod(blocked, 0o700); }
        await rm(path.join(linked, 'frontend'), {
            recursive: true
        });
        expect((await inspectRepository(path.join(repo, 'frontend'))).worktrees.find(x => x.path === linked)).toMatchObject({
            scopeAvailable: false, reason: 'missing-subfolder'
        });
        await symlink(root, path.join(linked, 'frontend'));
        expect((await inspectRepository(path.join(repo, 'frontend'))).worktrees.find(x => x.path === linked)).toMatchObject({
            scopeAvailable: false, reason: 'outside-checkout'
        });
        await rm(linked, {
            recursive: true
        });
        expect((await inspectRepository(repo)).worktrees.find(x => x.path === linked)).toMatchObject({
            exists: false, available: false
        });
    });
    test('nonGit differs from malformed Git and missing folders', async () => {
        const { root } = await fixture();
        const ordinary = path.join(root, 'ordinary');
        await mkdir(ordinary);
        expect(await inspectFolder(ordinary)).toEqual({
            path: ordinary, git: false
        });
        await writeFile(path.join(ordinary, '.git'), 'gitdir: /does/not/exist');
        await expect(inspectFolder(ordinary)).rejects.toMatchObject({
            code: 'git-inspection-failed'
        });
        await expect(inspectFolder(path.join(root, 'absent'))).rejects.toMatchObject({
            code: 'folder-unavailable'
        });
    });
    test('missing Git permits ordinary folders while marked and linked repositories stay blocked', async () => {
        const { root, repo } = await fixture();
        const ordinary = path.join(root, 'ordinary');
        const linked = path.join(root, 'linked-repository');
        await mkdir(ordinary);
        await symlink(repo, linked, 'junction');
        const folders = { ordinary, marked: repo, nested: path.join(repo, 'frontend'), linked };
        const moduleUrl = new URL('../desktop/main/services/worktree-service.mjs', import.meta.url).href;
        const program = `import { inspectFolder } from ${JSON.stringify(moduleUrl)};
const observations = {};
for (const [name, folder] of Object.entries(${JSON.stringify(folders)})) {
  try { observations[name] = await inspectFolder(folder); }
  catch (error) { observations[name] = { code: error.code, causeCode: error.cause?.code }; }
}
console.log(JSON.stringify(observations));`;
        // A separate process observes the actual missing-executable boundary without
        // changing shared test-worker PATH or replacing the production Git seam.
        const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
        environment.PATH = '';
        const observed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', program], {
            cwd: root, env: environment, encoding: 'utf8', timeout: 5000,
        }));
        expect(observed.ordinary).toEqual({ path: ordinary, git: false });
        for (const name of ['marked', 'nested', 'linked']) {
            expect(observed[name]).toEqual({ code: 'git-inspection-failed', causeCode: 'ENOENT' });
        }
    });
    test('validates exact checkout/subfolder and requires acknowledgment of changed commits', async () => {
        const { root, repo } = await fixture();
        const info = await inspectFolder(repo);
        await writeFile(path.join(repo, 'frontend', 'file'), 'second');
        git(repo, 'add', '.');
        git(repo, 'commit', '-m', 'second');
        const selection = {
            path: repo, relativePath: 'frontend', repositoryId: info.repositoryId, expectedCommit: info.commit
        };
        await expect(validateSelection(selection)).rejects.toMatchObject({
            code: 'checkout_changed'
        });
        expect((await validateSelection({
            ...selection, acknowledgeChange: true
        })).workingDirectory).toBe(path.join(repo, 'frontend'));
        await symlink(root, path.join(repo, 'escape'));
        expect((await inspectRepository(path.join(repo, 'frontend'))).worktrees.every(x => x.scopeAvailable)).toBe(true);
        await expect(validateSelection({
            ...selection, relativePath: 'escape', acknowledgeChange: true
        })).rejects.toMatchObject({
            code: 'outside-checkout'
        });
        await expect(validateSelection({
            ...selection, relativePath: 'frontend/file', acknowledgeChange: true
        })).rejects.toMatchObject({
            code: 'subfolder-unavailable'
        });
        await expect(validateSelection({
            ...selection, relativePath: 'missing', acknowledgeChange: true
        })).rejects.toMatchObject({
            code: 'subfolder-unavailable'
        });
    });
    test('uses cached remote base, durable random plan and idempotent creation/restart recovery', async () => {
        const { root, repo, service } = await fixture();
        git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
        git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
        const info = await service.inspect(repo);
        expect(info.defaultBase).toBe('refs/remotes/origin/main');
        const plan = await service.plan({
            repositoryPath: repo, relativePath: 'frontend'
        });
        expect(plan.branch).toMatch(/^relayer\/[a-f0-9]{32}$/);
        await expect(service.plan({ repositoryPath: repo, relativePath: 'backend', planId: plan.planId })).rejects.toMatchObject({ code: 'plan-conflict' });
        expect((await service.plan({ repositoryPath: repo, relativePath: 'frontend', planId: plan.planId })).planId).toBe(plan.planId);
        expect(JSON.parse(await readFile(path.join(root, 'receipts', `${plan.planId}.json`), 'utf8')).status).toBe('planned');
        await writeFile(path.join(repo, 'uncommitted-only'), 'must not copy');
        const [first, second] = await Promise.all([service.create(plan.planId), service.create(plan.planId)]);
        expect(first.path).toBe(second.path);
        await expect(readFile(path.join(first.path, 'uncommitted-only'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(first.workingDirectory).toBe(path.join(plan.path, 'frontend'));
        const restarted = createWorktreeService({
            worktreeRoot: path.join(root, 'managed'), storeDirectory: path.join(root, 'receipts')
        });
        expect((await restarted.create(plan.planId)).path).toBe(first.path);
        expect((await service.inspect(repo)).worktrees).toHaveLength(2);
        expect(info.bases.find(x => x.ref === 'checkout')).toMatchObject({
            name: 'Checkout', commit: plan.commit
        });
        await writeFile(path.join(first.path, 'new-file'), 'edit');
        git(first.path, 'add', '.');
        git(first.path, 'commit', '-m', 'user edit');
        await expect(restarted.create(plan.planId)).rejects.toMatchObject({
            code: 'checkout_changed'
        });
        await expect(restarted.create({
            planId: plan.planId, acknowledgedState: {
                branch: plan.branch, commit: plan.commit
            }
        })).rejects.toMatchObject({
            code: 'checkout_changed'
        });
        expect((await restarted.create({
            planId: plan.planId, acknowledgedState: {
                branch: plan.branch, commit: git(first.path, 'rev-parse', 'HEAD')
            }
        })).commit).toBe(git(first.path, 'rev-parse', 'HEAD'));
    }, 30_000);
    test('reconciles interrupted exact creation and rejects conflicts without adoption', async () => {
        const { repo, service } = await fixture();
        const exact = await service.plan({
            repositoryPath: repo, base: 'checkout'
        });
        expect((await service.reconcile(exact.planId)).recovery).toBe('absent');
        git(repo, 'worktree', 'add', '-b', exact.branch, exact.path, exact.commit);
        expect((await service.reconcile(exact.planId)).recovery).toBe('exact');
        git(exact.path, 'checkout', '--detach');
        await expect(service.create(exact.planId)).rejects.toMatchObject({
            code: 'checkout_changed'
        });
        const unknown = await service.plan({
            repositoryPath: repo, base: 'main'
        });
        git(repo, 'worktree', 'add', '--detach', unknown.path, unknown.commit);
        await expect(service.reconcile(unknown.planId)).rejects.toMatchObject({
            code: 'creation-conflict'
        });
        const conflict = await service.plan({
            repositoryPath: repo, base: 'main'
        });
        await mkdir(conflict.path);
        await writeFile(path.join(conflict.path, 'keep'), 'untouched');
        await expect(service.create(conflict.planId)).rejects.toMatchObject({
            code: 'creation-conflict'
        });
        expect(await readFile(path.join(conflict.path, 'keep'), 'utf8')).toBe('untouched');
    }, 30_000);
    test('blocks unknown defaults, changed bases and retains created tree when subfolder absent', async () => {
        const { repo, service } = await fixture();
        // A local unknown default cannot inherit the developer's global default.
        git(repo, 'config', 'init.defaultBranch', 'unavailable-fixture-default');
        await expect(service.plan({
            repositoryPath: repo
        })).rejects.toMatchObject({
            code: 'base-unavailable'
        });
        await expect(service.plan({
            repositoryPath: repo, base: 'main', expectedCommit: '0'.repeat(40)
        })).rejects.toMatchObject({
            code: 'base-changed'
        });
        const p = await service.plan({
            repositoryPath: repo, base: 'main', relativePath: 'backend'
        });
        await expect(service.create(p.planId)).rejects.toMatchObject({
            code: 'subfolder-unavailable'
        });
        expect((await service.readPlan(p.planId)).status).toBe('created');
        expect((await service.reconcile(p.planId)).recovery).toBe('exact');
    });
});
