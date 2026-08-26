See @AGENTS.md

## Fork operations (read before running or changing this checkout)

This is the NSAI fork, and it does not behave like a stock bb source checkout:

- `bb.local` is served by a **packaged production build** under launchd
  (`com.jpk.bb-fork-prod`), not by `pnpm dev`. **There is no hot reload.** After
  changing fork source, rebuild and restart or the running app keeps the old code:

  ```bash
  cd ~/bb && pnpm exec turbo run build --filter=bb-app
  launchctl kickstart -k gui/$UID/com.jpk.bb-fork-prod
  ```

- Never run `pnpm dev` while that service is up — they share a data dir and
  ports, so it is an `EADDRINUSE` crash loop.
- Never merge, rebase, or check out upstream tags inside `~/bb` while the
  service is running; it builds from this checkout. Use a worktree.
- Upstream releases are consumed by **merging** `desktop-v<version>`. Do not run
  `bb-plugins/bb-fork/scripts/rebase-onto-upstream.sh` to completion — its final
  `git reset --hard` would discard most of the fork.
- Fork migrations live in a reserved `09xx` range and must always carry the
  newest journal `when` timestamps. Drizzle applies a migration only when its
  stamp is newer than the newest already applied, so a fork migration stamped
  before an incoming upstream one makes Drizzle **silently skip** that upstream
  migration.

Full detail: [docs/fork/operations.md](docs/fork/operations.md).
