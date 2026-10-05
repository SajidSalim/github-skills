# Privacy policy

The github-workflow plugin collects no data. It has no server, no analytics and no telemetry, and
nothing it does reaches its author.

## What runs, and where

- **Skills** are instructions Claude Code reads. They run nothing themselves.
- **Scripts** and the **hook** run on your machine. The hook reads the tool call Claude Code hands
  it, your repository's `.github/github-workflow.json` and a few git files, and asks `git` read-only
  questions. It writes no files and makes no network requests.
- **GitHub** is reached only through your own GitHub CLI, `gh`, logged in as you. The skills and
  scripts use it to search, create, label and comment on issues and pull requests in the
  repositories you work on, and the label gate reads the labels of an issue or pull request just
  created or edited. That data goes to GitHub and is covered by
  [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- **Credentials** stay with `gh`, which keeps its token in your OS keyring. The plugin never reads,
  stores, prints or forwards a token.

## Settings

The plugin's two options, `closing_keyword_gate` and `discard_gate`, are stored by Claude Code on
your machine.

Claude Code itself, and the conversations in which the plugin is used, are covered by
[Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).

## Questions

Open an issue in the repository this plugin comes from.
