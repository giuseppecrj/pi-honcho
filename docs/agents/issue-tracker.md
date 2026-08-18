# Issue tracker: GitHub

Issues and specifications for this repository live in GitHub Issues. Use the `gh` CLI.

## Conventions

- Create an issue with `gh issue create`. Use a heredoc for a multi-line body.
- Read an issue with `gh issue view <number> --comments` and include labels.
- List issues with `gh issue list --state open` and request the fields needed for the task.
- Add comments with `gh issue comment <number>`.
- Change labels with `gh issue edit <number> --add-label <label>` or `--remove-label <label>`.
- Close an issue with `gh issue close <number>`.

Infer the repository from `git remote -v`; `gh` does this when you run it in this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill workflow

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket, run `gh issue view <number> --comments`.
