# Desktop release authority

These rulesets close the live repository-control assumptions made by the desktop release workflows. They are inert JSON definitions until a repository administrator explicitly imports or applies them.

## Intended controls

`main-ruleset.json` requires every `main` update to come through a pull request, requires the GitHub Actions `check` job from app ID `15368`, requires the branch to be current, blocks force pushes and deletion, and keeps history linear. It requires zero approving reviews because this personal repository currently has one administrator. The administrator still cannot push directly to `main`.

`desktop-tags-ruleset.json` restricts creation, replacement, and deletion of `desktop-v*` tags to repository administrators. Repository role ID `5` is GitHub's built-in administrator role. The signed-candidate workflow separately rejects a tag unless its version matches `desktop/package.json` and its commit is on `main`.

Do not activate the existing disabled `main` ruleset unchanged. It contains creation and update restrictions with no bypass actor and would prevent ordinary repository updates.

## Read-only audit

Run the repository audit at any time:

```sh
npm run desktop:release:audit-authority
```

The command prints names and policy results only. It never prints secret or variable values and never changes GitHub.

## Apply after explicit approval

From the repository root, preview both payloads before sending them:

```sh
jq . infra/github/desktop-release-authority/main-ruleset.json
jq . infra/github/desktop-release-authority/desktop-tags-ruleset.json
```

Applying either command changes live repository policy:

```sh
gh api --method POST repos/vishaltandale00/relayer-graphcomplete/rulesets \
  --input infra/github/desktop-release-authority/main-ruleset.json

gh api --method POST repos/vishaltandale00/relayer-graphcomplete/rulesets \
  --input infra/github/desktop-release-authority/desktop-tags-ruleset.json
```

Run the read-only audit again after both API calls. Do not merge, tag, or publish merely because the policy audit passes; those remain separate approval gates.
