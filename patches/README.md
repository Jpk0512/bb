# NSAI patch set (historical)

These files are the first fork changes, from when the plan was to keep core
edits to a minimum and replay a handful of patches onto each upstream tag.
That constraint is gone: the fork now edits bb core directly and this branch is
the source of truth.

Read them as a record of how the fork started. Do not add new ones, and do not
treat them as the authoritative form of these changes — the commits on
`nsai/phase-5-fork` are. `0001`-`0005` are already commits on this branch, so
replaying them onto the current branch would conflict with itself.

Drift is caught by `.github/workflows/fork-upstream-rebase.yml`, which rebases
the branch onto upstream and re-checks each surface the fork owns.

Do not replace `/Applications/bb.app`. Official updates stay on the packaged
app; this checkout is the isolated source instance.
