# Fork Operations

How this fork actually runs on the maintainer's machine, and what you must do
after changing its source. This file is fork-owned: keep fork-specific
operational detail here rather than in `AGENTS.md`, so upstream merges touch it
as little as possible.

## The fork is served as a production build, not `pnpm dev`

`bb.local` is the daily driver — browser, iOS, and the desktop shell all point
at it. It is served by a **packaged `bb-app` runtime**, not by Vite:

| Piece | Value |
| --- | --- |
| launchd service | `com.jpk.bb-fork-prod` |
| launcher script | `bb-plugins/bb-fork/scripts/prod-launchd.sh` |
| command | `node packages/bb-app/dist/bb-app.js start` |
| data dir | `~/.bb-dev/bb-230278bb91bc` |
| server / daemon ports | `23539` / `31539` |
| log | `/tmp/bb-fork-prod.log` |
| `bb.local` front end | OrbStack container `bb-local-proxy-proxy-1` (Caddy) → `host.docker.internal:23539` |

Serving the Vite dev server to real use is what made the app reload on every
iOS tab switch: HMR reconnects force a full page reload when a backgrounded
tab returns, and dev bundles are unoptimized. Production build, no HMR socket,
no reload loop.

### After changing fork source, rebuild and restart

A source edit does **not** reach the running app. There is no hot reload here.

```bash
cd ~/bb && pnpm exec turbo run build --filter=bb-app
launchctl kickstart -k gui/$UID/com.jpk.bb-fork-prod
```

Then confirm the server answers and is serving built assets (a `/assets/index-*.js`
tag, never `@vite/client`):

```bash
curl -s http://127.0.0.1:23539/ | grep -o 'src="/assets/index-[^"]*"'
```

### Running an HMR dev session instead

Production and dev share the same data dir **and the same ports**, so running
both at once is an `EADDRINUSE` crash loop. Stop production first:

```bash
launchctl bootout gui/$UID/com.jpk.bb-fork-prod
BB_TELEMETRY=false pnpm dev
```

For browser HMR, also point the Caddyfile upstream at `:5191` and restart
`bb-local-proxy-proxy-1`. Reverse both when you are done. The dev launchd job
`com.jpk.bb-fork-dev` exists but is deliberately on-demand
(`RunAtLoad`/`KeepAlive` false).

## Never build or merge in `~/bb` while production is running

`prod-launchd.sh` builds from the `~/bb` checkout. A merge or rebase in place
means the service can restart onto a half-written tree. Do disruptive git work
in a worktree:

```bash
git worktree add ~/bb-wt/<name> -b <branch> nsai/phase-5-fork
```

## Upstream updates

Upstream is consumed by **merging** `desktop-v<version>` into
`nsai/phase-5-fork`, never by replacing `/Applications/bb.app`.

- **Do not follow `bb-plugins/bb-fork/scripts/rebase-onto-upstream.sh` to
  completion.** It checks out the upstream tag, applies only `patches/`, and
  then tells you to `git reset --hard` the fork branch onto it. `patches/` is
  closed and covers only the fork's earliest commits; that reset would discard
  most of the fork.
- Prefer merge over rebase. Rebase replays every fork commit against every
  upstream commit and re-resolves the same conflicts repeatedly; the nightly
  `fork-upstream-rebase.yml` tripwire fails on an early commit for exactly this
  reason.
- **Migrations: fork entries must always carry the newest `when` timestamps.**
  The fork reserves the `09xx` migration range so its files sort after
  upstream's `01xx`, but Drizzle does not apply migrations by name — it applies
  a migration only when its journal `when` is newer than the newest already
  applied (`lastDbMigration < migration.folderMillis`). A fork migration stamped
  earlier than an incoming upstream migration therefore makes Drizzle **silently
  skip** that upstream migration on any database that already ran the fork one.
  After every upstream merge, re-stamp the fork's `09xx` journal entries to
  `max(upstream when) + n` and confirm the journal is monotonic. Also stitch
  `0900_snapshot.json` `prevId` to the last upstream snapshot `id` (0109 after
  0.40.0) so the snapshot chain matches the journal. Do not invent snapshot
  bodies by hand; if the schema changed, regenerate with Drizzle. `migrate.ts`'s
  `repairBranchLocal*` helpers are upstream's precedent for the same hazard.
- Existing databases that already applied a fork migration need a one-time
  ledger repair after a merge, or the upstream migrations older than that stamp
  stay missing. Verify against a copy of the database before the real one.
- `HOST_DAEMON_PROTOCOL_VERSION` diverges fast (fork 131 vs upstream 170 at
  0.40.0). Take upstream's number and re-apply the fork's own wire changes on
  top of it; never carry the fork's lower number forward.

## Data safety

- The fork's data dir is `~/.bb-dev/bb-230278bb91bc`. `~/.bb` belongs to the
  packaged app — never point the fork at it, and never copy `~/.bb/bb.db` in.
- Back up before schema or bulk-data work:
  `sqlite3 ~/.bb-dev/bb-230278bb91bc/bb.db ".backup '~/backups/bb-dev-db/<name>.db'"`.
- Never `pnpm reset` in this repo (it targets production `~/.bb`); `pnpm reset:dev`
  wipes the isolated instance only.
