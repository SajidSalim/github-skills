# Publishing

## Releasing a new version

1. Update `plugins/github-workflow/CHANGELOG.md` with a new `## [x.y.z] - YYYY-MM-DD` entry.
2. Set the same version in `plugins/github-workflow/.claude-plugin/plugin.json` and in the
   plugin's entry in `.claude-plugin/marketplace.json`.
3. Run everything:
   ```bash
   bash plugins/github-workflow/tests/run-tests.sh
   node --test plugins/github-workflow/tests/hooks/*.test.mjs
   claude plugin validate plugins/github-workflow --strict
   claude plugin validate . --strict
   ```
4. Once per release, run the adoption flow live; the suites only pin the setup and doctor skills'
   text. In a throwaway GitHub repository, start
   `claude --plugin-dir <this checkout>/plugins/github-workflow` and type
   `/github-workflow:setup --dry-run`, `/github-workflow:setup` and `/github-workflow:doctor`
   (both skills are user-only). Check that the doctor's mode row reads `adopted`, then delete the
   repository.
5. Commit on a branch, open a PR, let CI pass, and merge it into `main`.
6. Then, on an up-to-date `main` (`git switch main && git pull --ff-only`), tag:
   `claude plugin tag plugins/github-workflow --push` — creates `github-workflow--v<version>`
   after checking that `plugin.json` and the marketplace entry agree. It tags whatever is checked
   out and does not check the branch, so never run it on a feature branch: a squash merge would
   leave the tag on a commit `main` never contains.

Users get the update with `claude plugin update github-workflow@github-skills`.

## Keep private material out of this repository

- A marketplace install (`/plugin marketplace add`) clones the whole repository, not just
  `plugins/`, so everything in it — git history and commit messages included — reaches every user.
- The plugin's own scrub and privacy tests cover only `plugins/`, the marketplace `README.md` and
  `.claude-plugin/marketplace.json`. Nothing checks the rest.
- So design notes, plans and anything naming another private repository or a local path stay
  outside this repository. Git history keeps what a later commit deletes, so the only fix for a
  leak that was pushed is a fresh history.
- Commit with your GitHub no-reply address (`<id>+<login>@users.noreply.github.com`), never a
  personal one.
- Making the repository public is the owner's decision. Until then the marketplace install works
  only for collaborators.

## Submitting to Anthropic's plugin directory

The directory lists plugins across claude.ai, Cowork and Claude Code.

- [ ] The plugin passes `claude plugin validate plugins/github-workflow --strict`
- [ ] `README.md` and `LICENSE` sit at the plugin root
- [ ] The repository is public at `https://github.com/SajidSalim/github-skills`, once its
      history has been checked against the section above
- [ ] Submit at <https://claude.ai/directory/manage> (needs a paid claude.ai plan), pointing at the
      repository and the sub-path `plugins/github-workflow`
- [ ] Once listed, keep the name: renaming breaks existing installs (a marketplace `renames` entry
      is the only migration path)
