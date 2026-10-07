import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, stat, realpath, mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import { constants, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
const execute = promisify(execFile);
export class WorktreeError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'WorktreeError';
        this.code = code;
    }
}
const fail = (code, message) => {
    throw new WorktreeError(code, message);
};
async function git(cwd, args) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    env.GIT_TERMINAL_PROMPT = '0';
    try {
        return (await execute('git', ['-C', cwd, ...args], {
            env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000
        })).stdout;
    }
    catch (error) {
        throw Object.assign(new WorktreeError('git-inspection-failed', 'Git inspection failed. Retry after restoring repository access.'), {
            cause: error
        });
    }
}
async function optionalGit(cwd, args) {
    try {
        return (await git(cwd, args)).trim();
    }
    catch {
        return null;
    }
}
const inside = (root, candidate) => {
    const rel = path.relative(root, candidate);
    return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
function canonicalDestination(target) {
    let current = path.resolve(target), suffix = [];
    while (!existsSync(current)) {
        suffix.unshift(path.basename(current));
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return path.join(realpathSync(current), ...suffix);
}
async function exists(target) {
    try {
        await lstat(target);
        return true;
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return false;
        throw e;
    }
}
async function hasGitMarker(target) {
    // Follow the selected folder's canonical location as well as its displayed
    // path, so missing Git cannot downgrade a linked repository to a plain folder.
    for (const start of new Set([path.resolve(target), await realpath(target)])) {
        for (let current = start;;) {
            if (await exists(path.join(current, '.git')))
                return true;
            const parent = path.dirname(current);
            if (parent === current)
                break;
            current = parent;
        }
    }
    return false;
}
export async function inspectFolder(folder) {
    const opened = path.resolve(folder);
    try {
        await access(opened, constants.R_OK | constants.X_OK);
        if (!(await stat(opened)).isDirectory())
            fail('folder-unavailable', 'The selected folder is unavailable.');
    }
    catch (error) {
        if (error instanceof WorktreeError)
            throw error;
        fail('folder-unavailable', 'The selected folder is unavailable.');
    }
    let root;
    try {
        root = (await git(opened, ['rev-parse', '--show-toplevel'])).trim();
    }
    catch (error) {
        // Git is optional for ordinary folders. A missing executable may use
        // that path only without a repository marker; all marked-repository and
        // other inspection failures remain blocked for explicit recovery.
        if ((error.cause?.code === 'ENOENT' || /not a git repository/i.test(error.cause?.stderr || '')) && !(await hasGitMarker(opened)))
            return {
                path: opened, git: false
            };
        throw error;
    }
    const checkoutRoot = await realpath(root);
    const commonDirectory = await realpath((await git(opened, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    const branch = (await git(opened, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(error => {
        if (error.cause?.code === 1)
            return '';
        throw error;
    })).trim();
    const commit = await git(opened, ['rev-parse', '--verify', 'HEAD']).then(value => value.trim()).catch(async (error) => {
        if (branch && !(await optionalGit(opened, ['show-ref', '--verify', `refs/heads/${branch}`])))
            return null;
        throw error;
    });
    const canonicalOpened = await realpath(opened);
    if (!inside(checkoutRoot, canonicalOpened))
        fail('outside-checkout', 'The selected subfolder resolves outside its checkout.');
    return {
        path: opened, git: true, repositoryRoot: checkoutRoot, checkoutRoot, commonDirectory, repositoryId: createHash('sha256').update(commonDirectory).digest('hex'), relativePath: path.relative(checkoutRoot, canonicalOpened), branch: branch || 'detached', commit
    };
}
export async function inspectRepository(folder) {
    const info = await inspectFolder(folder);
    if (!info.git)
        return info;
    const records = (await git(info.checkoutRoot, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').filter(Boolean);
    const worktrees = await Promise.all(records.map(async (record) => {
        const fields = record.split('\0').filter(Boolean);
        const target = fields.find(x => x.startsWith('worktree '))?.slice(9);
        if (!target)
            fail('git-inspection-failed', 'Git returned an invalid worktree inventory.');
        const present = await exists(target);
        const canonicalTarget = present ? await realpath(target).catch(() => target) : target;
        let accessible = false, dirty = false;
        if (present) {
            try {
                await access(target, constants.R_OK | constants.X_OK);
                accessible = true;
                dirty = Boolean((await git(target, ['status', '--porcelain'])).trim());
            }
            catch {
                accessible = false;
            }
        }
        let reason = !present ? 'missing' : !accessible ? 'inaccessible' : '';
        if (!reason && info.relativePath) {
            try {
                const scoped = await realpath(path.join(canonicalTarget, info.relativePath));
                if (!inside(canonicalTarget, scoped))
                    reason = 'outside-checkout';
                else if (!(await stat(scoped)).isDirectory())
                    reason = 'missing-subfolder';
                else
                    await access(scoped, constants.R_OK | constants.X_OK);
            }
            catch {
                reason = 'missing-subfolder';
            }
        }
        return {
            path: canonicalTarget, branch: fields.find(x => x.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') || 'detached', commit: fields.find(x => x.startsWith('HEAD '))?.slice(5) || null, detached: fields.includes('detached'), locked: fields.some(x => x === 'locked' || x.startsWith('locked ')), lockReason: fields.find(x => x.startsWith('locked '))?.slice(7) || '', exists: present, accessible, available: present && accessible, scopeAvailable: !reason, reason, dirty, repositoryId: info.repositoryId
        };
    }));
    const refs = (await git(info.checkoutRoot, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads', 'refs/remotes'])).trim().split('\n').filter(Boolean);
    const bases = refs.map(line => {
        const [ref, commit, symbolic] = line.split('\0');
        return {
            ref, name: ref.replace(/^refs\/(heads|remotes)\//, ''), commit, remote: ref.startsWith('refs/remotes/'), symbolic
        };
    }).filter(x => !x.symbolic);
    const remoteHead = await optionalGit(info.checkoutRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const configured = await optionalGit(info.checkoutRoot, ['config', '--get', 'init.defaultBranch']);
    const defaultBase = bases.find(x => x.ref === remoteHead) || bases.find(x => configured && x.ref === `refs/heads/${configured}`) || null;
    if (info.commit)
        bases.unshift({
            ref: 'checkout', name: 'Checkout', commit: info.commit, remote: false
        });
    return {
        ...info, worktrees, bases, defaultBase: defaultBase?.ref || null
    };
}
export async function validateSelection({ path: target, relativePath = '', repositoryId, expectedBranch, expectedCommit, acknowledgeChange = false, acknowledgedState }) {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..'))
        fail('outside-checkout', 'Invalid working subfolder.');
    const info = await inspectFolder(target);
    if (!info.git || info.repositoryId !== repositoryId)
        fail('repository-changed', 'This checkout belongs to a different repository.');
    if (await realpath(target) !== info.checkoutRoot)
        fail('checkout-changed', 'Select the registered checkout root.');
    const inventory = await inspectRepository(target);
    if (!inventory.worktrees.some(x => path.resolve(x.path) === info.checkoutRoot))
        fail('checkout-unregistered', 'This checkout is no longer registered.');
    const cwd = path.resolve(info.checkoutRoot, relativePath);
    let resolved;
    try {
        resolved = await realpath(cwd);
        await access(resolved, constants.R_OK | constants.X_OK);
        if (!(await stat(resolved)).isDirectory())
            fail('subfolder-unavailable', 'The selected working subfolder is not a directory.');
    }
    catch {
        fail('subfolder-unavailable', 'The selected working subfolder is unavailable.');
    }
    if (!inside(info.checkoutRoot, resolved))
        fail('outside-checkout', 'The working subfolder resolves outside this checkout.');
    const changed = (expectedBranch !== undefined && expectedBranch !== info.branch) || (expectedCommit !== undefined && expectedCommit !== info.commit);
    const acknowledged = acknowledgedState ? acknowledgedState.branch === info.branch && acknowledgedState.commit === info.commit : acknowledgeChange;
    if (changed && !acknowledged)
        throw Object.assign(new WorktreeError('checkout_changed', 'The checkout branch or commit changed. Review it before sending.'), {
            details: {
                path: info.checkoutRoot, branch: info.branch, commit: info.commit
            }
        });
    return {
        ...info, cwd, workingDirectory: cwd, changed
    };
}
export function createWorktreeService({ worktreeRoot, storeDirectory }) {
    const root = canonicalDestination(worktreeRoot), store = canonicalDestination(storeDirectory), inflight = new Map();
    const receiptPath = id => {
        if (!/^[a-f0-9]{32}$/.test(id))
            fail('invalid-plan', 'Invalid creation plan.');
        return path.join(store, `${id}.json`);
    };
    async function save(plan, exclusive = false) {
        await mkdir(store, {
            recursive: true, mode: 0o700
        });
        const file = receiptPath(plan.planId);
        if (exclusive) {
            const handle = await open(file, 'wx', 0o600);
            try {
                await handle.writeFile(JSON.stringify(plan));
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await syncDirectory(store);
            return;
        }
        const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
        const handle = await open(temp, 'wx', 0o600);
        try {
            await handle.writeFile(JSON.stringify(plan));
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temp, file);
        await syncDirectory(store);
    }
    async function syncDirectory(directory) {
        let handle;
        try {
            handle = await open(directory, 'r');
            await handle.sync();
        }
        catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code))
                throw error;
        }
        finally {
            await handle?.close();
        }
    }
    async function readPlan(id) {
        let value;
        try {
            value = JSON.parse(await readFile(receiptPath(id), 'utf8'));
        }
        catch {
            fail('plan-unavailable', 'The saved creation plan is unavailable.');
        }
        if (value.version !== 1 || value.planId !== id || value.path !== path.join(root, id) || value.branch !== `relayer/${id}` || typeof value.repositoryPath !== 'string' || typeof value.repositoryId !== 'string' || typeof value.relativePath !== 'string' || path.isAbsolute(value.relativePath) || value.relativePath.split(/[\\/]/).includes('..') || !/^[a-f0-9]{40,64}$/.test(value.commit) || !['planned', 'creating', 'created', 'failed'].includes(value.status))
            fail('invalid-plan', 'The saved creation plan is invalid.');
        return value;
    }
    async function plan({ repositoryPath, base, expectedCommit, relativePath = '', planId = randomBytes(16).toString('hex') }) {
        receiptPath(planId);
        if (await exists(receiptPath(planId))) {
            const saved = await readPlan(planId);
            const owner = await inspectFolder(repositoryPath);
            const sameBase = !base || base === saved.base || base === saved.base.replace(/^refs\/(heads|remotes)\//, '');
            if (!owner.git || owner.repositoryId !== saved.repositoryId || relativePath !== saved.relativePath || !sameBase || (expectedCommit && expectedCommit !== saved.commit))
                fail('plan-conflict', 'The saved creation plan belongs to another selection.');
            return saved;
        }
        const info = await inspectRepository(repositoryPath);
        if (!info.git)
            fail('not-git', 'Worktrees require a Git repository.');
        let commit, ref = base || info.defaultBase;
        if (ref === 'checkout') {
            if (!info.commit)
                fail('base-unavailable', 'The checkout has no committed base.');
            commit = info.commit;
        }
        else {
            const selected = info.bases.find(x => x.ref === ref || x.name === ref);
            if (!selected)
                fail('base-unavailable', 'Choose an available base branch.');
            ref = selected.ref;
            commit = selected.commit;
        }
        if (expectedCommit && expectedCommit !== commit)
            fail('base-changed', 'The base commit changed. Review it before sending.');
        if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..'))
            fail('outside-checkout', 'Invalid working subfolder.');
        const value = {
            version: 1, planId, repositoryPath: info.checkoutRoot, repositoryId: info.repositoryId, commonDirectory: info.commonDirectory, base: ref, commit, baseCommit: commit, relativePath, branch: `relayer/${planId}`, path: path.join(root, planId), status: 'planned'
        };
        try {
            await save(value, true);
        }
        catch (error) {
            if (error.code === 'EEXIST')
                return plan({ repositoryPath, base, expectedCommit, relativePath, planId });
            throw error;
        }
        return value;
    }
    async function reconcile(id) {
        const value = await readPlan(id);
        const current = await inspectRepository(value.repositoryPath);
        if (!current.git || current.repositoryId !== value.repositoryId)
            fail('repository-changed', 'The planned repository identity changed.');
        const entry = current.worktrees.find(x => path.resolve(x.path) === value.path);
        if (!entry) {
            if (await exists(value.path) || current.bases.some(x => x.ref === `refs/heads/${value.branch}`))
                fail('creation-conflict', 'The planned destination or branch is occupied.');
            return {
                ...value, recovery: 'absent'
            };
        }
        if ((value.status !== 'created' && (entry.branch !== value.branch || entry.commit !== value.commit)) || !entry.exists || !entry.accessible)
            fail('creation-conflict', 'The created worktree does not match the saved plan.');
        const actual = await inspectFolder(value.path);
        if (actual.repositoryId !== value.repositoryId)
            fail('creation-conflict', 'The created worktree repository does not match.');
        value.status = 'created';
        await save(value);
        return {
            ...value, recovery: 'exact', cwd: path.join(value.path, value.relativePath)
        };
    }
    async function create(input, options = {}) {
        const id = typeof input === 'string' ? input : input?.planId;
        const acknowledgedState = typeof input === 'string' ? options.acknowledgedState : input.acknowledgedState;
        if (inflight.has(id))
            return inflight.get(id);
        const operation = (async () => {
            let value = await reconcile(id);
            if (value.recovery === 'exact')
                return validateCreated(value, acknowledgedState);
            await mkdir(root, {
                recursive: true, mode: 0o700
            });
            if (await realpath(root) !== root)
                fail('creation-conflict', 'The managed worktree directory changed.');
            value.status = 'creating';
            await save(value);
            try {
                await git(value.repositoryPath, ['worktree', 'add', '-b', value.branch, value.path, value.commit]);
            }
            catch (error) {
                const recovered = await reconcile(id);
                if (recovered.recovery === 'exact')
                    return validateCreated(recovered, acknowledgedState);
                value.status = 'failed';
                await save(value);
                throw new WorktreeError('creation-failed', 'Worktree creation failed. The draft and plan are retained.');
            }
            return validateCreated(await reconcile(id), acknowledgedState);
        })();
        inflight.set(id, operation);
        try {
            return await operation;
        }
        finally {
            inflight.delete(id);
        }
    }
    async function validateCreated(value, acknowledgedState) {
        const selection = await validateSelection({
            path: value.path, relativePath: value.relativePath, repositoryId: value.repositoryId, expectedBranch: value.branch, expectedCommit: value.commit, acknowledgedState
        });
        return {
            ...value, cwd: selection.cwd, workingDirectory: selection.cwd, checkoutRoot: value.path, branch: selection.branch, commit: selection.commit
        };
    }
    return {
        inspect: inspectRepository, validateSelection, plan, create, reconcile, readPlan
    };
}
