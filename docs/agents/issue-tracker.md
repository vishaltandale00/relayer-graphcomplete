# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues at `vishaltandale00/relayer-graphcomplete`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a body file for multiline bodies.
- **Read an issue**: `gh issue view <number> --comments`, including its labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When enabled manually, external PRs run through the same labels and states as issues using the corresponding `gh pr` commands.

GitHub shares one number space across issues and pull requests. Resolve an ambiguous bare number by checking the pull request first and then the issue.

## When a skill says “publish to the issue tracker”

Create a GitHub issue.

## When a skill says “fetch the relevant ticket”

Run `gh issue view <number> --comments`.

## Wayfinding operations

The map is a single GitHub issue with child issues as decision tickets.

- **Map**: an issue labelled `wayfinder:map` containing Destination, Notes, Decisions so far, Not yet specified, and Out of scope.
- **Child ticket**: a GitHub sub-issue of the map. If sub-issues are unavailable, add it to the map’s task list and put `Part of #<map>` at the beginning of the child body.
- **Ticket labels**: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking**: use GitHub’s native issue dependencies. If unavailable, use a `Blocked by: #<number>` line in the child body.
- **Frontier**: the map’s open, unblocked, unassigned child issues in map order.
- **Claim**: assign the ticket to the driving developer before beginning work.
- **Resolve**: post the decision as a resolution comment, close the ticket, and append a linked one-line context pointer to the map’s Decisions-so-far section.
