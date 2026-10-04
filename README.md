# github-skills

Claude Code plugins for working GitHub with discipline.

| Plugin | What it does |
|---|---|
| [github-workflow](plugins/github-workflow/) | A disciplined issue-to-PR workflow for coding agents: search for duplicates before filing, claim via the comment thread, branch and PR without merging, label to a strict taxonomy, and close with a written record — with opt-in hooks that enforce it |

## Install

In Claude Code:

```text
/plugin marketplace add SajidSalim/github-skills
/plugin install github-workflow@github-skills
```

Or from a shell:

```bash
claude plugin marketplace add SajidSalim/github-skills
claude plugin install github-workflow@github-skills
```

Restart Claude Code to load a newly installed plugin. Update later with
`claude plugin update github-workflow@github-skills`.

## Contributing

Each plugin carries its own tests — see its README. Before a release: `claude plugin validate
. --strict` and `claude plugin validate plugins/<name> --strict`, and the steps in
[docs/publishing.md](docs/publishing.md).

## License

[MIT](LICENSE)
