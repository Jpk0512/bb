# bb UI Master Implementation List — status

**Branch:** `nsai/phase-5-fork`  
**Board:** [BBF-40](https://nsai-fk.getbb.app) (in review), phases BBF-31…39  
**As of:** 2026-08-24 (`aa36d72fb` UI slices + `6d57f05ad` rebase-workflow fix)

Original spec: `/tmp/bb-ui-review/MASTER-IMPLEMENTATION.md` (v1 ideas + v2 spec + sidebar sequence).  
This file is the **living status**. Items are **done**, **partial**, or **left**.

**Score:** 62 items → **~28 done**, **~10 partial**, **~24 left**.  
Phases 0–8 each shipped a *scoped slice*. The remaining work is the big pieces (Monaco/write, compact rail, plugin kit) and the polish catalogue.

| Phase | Board | Shipped | Left |
|---|---|---|---|
| 0 Guardrails | BBF-31 done | M0.1–M0.4, M0.6 | M0.5 Board clip (plugin) |
| 1 Design system | BBF-32 done | M1.1, M1.3–M1.6 | M1.2 (already met), M1.7–M1.9 |
| 2 Sidebar I | BBF-33 done | M2.2–M2.5 | M2.1 glyph, M2.6 badges, M2.7 icons |
| 3 Sidebar II | BBF-34 done | M3.1, M3.2, M3.4 | M3.3 auto-archive |
| 4 Session chrome | BBF-35 done | M4.1 (partial), M4.8 | M4.2–M4.7, M4.9–M4.11 |
| 5 Palette + kit | BBF-36 done | M5.1, M5.2 | M5.3 kit, M5.4 plugin migrate |
| 6 Files + Monaco | BBF-37 done | M6.1 (browse), M6.3 existed | M6.2 Monaco, M6.4 write RPC, M6.5 |
| 7 Rail + responsive | BBF-38 done | M7.3 (narrow panel) | M7.1 compact rail, M7.2 browser, M7.4 density |
| 8 Polish | BBF-39 done | M8.1 (partial), M8.6, M8.10 (partial) | rest of M8 |

---

## Phase 0 — Guardrails

- **M0.1 Filter retired threads** — **done.** `retired: false` on sidebar bootstrap; test in `public-threads.defaults.test.ts`.
- **M0.2 Border-token inversion** — **done.** Hairline is lighter than `--border` in both themes.
- **M0.3 Repair `--subtle-foreground`** — **done.** Mix ~68/69% ink (≥4.5:1); `--decoration-foreground` for placeholders/icons; no `text-subtle-foreground/` opacity on body text.
- **M0.4 Contrast guard test** — **partial.** Opaque text tiers + hairline weight + opacity-ban test. No repo-wide raw-hex lint.
- **M0.5 Board column clip** — **left.** Board plugin (`bb-plugin-board`); not verified at 1280/1512.
- **M0.6 Error ≠ loading** — **done.** Inbox has distinct loading / empty / error+Retry.

## Phase 1 — Design-system core

- **M1.1 Typography ramp** — **done.** `packages/shared-ui/src/components/ui/typography.tsx` (`SidebarNavText`, `SidebarThreadText`, `SectionLabel`, `MetaText`, `MonoCommand`).
- **M1.2 Control size scale** — **done (already met).** Header/icon sizes were already 28/32; no change.
- **M1.3 Switch** — **done.** `data-[state=checked]:bg-primary`, 32×18 (36×20 coarse).
- **M1.4 Motion tokens** — **done.** `--motion-micro/control/surface` + `--ease-standard`.
- **M1.5 Focus / selection / scrollbar** — **done.** Themed `::selection`, thin scrollbars, focus-visible rings.
- **M1.6 Popover elevation** — **done.** `--surface-raised-solid` on dropdown/popover/command.
- **M1.7 Accent budget** — **left.** No Board/hero accent sweep.
- **M1.8 White FAB** — **left / n/a.** No unlabeled near-white FAB found; TOC/panel toggles already labeled.
- **M1.9 Agentation toolbar** — **left.** No writable Agentation checkout in this pass.

## Phase 2 — Sidebar I

- **M2.1 Retired filter + “continued” glyph** — **partial.** Filter shipped in M0.1. Successor stacked-paper glyph **left** (no successor field used).
- **M2.2 Sidebar typography** — **done.** Classes applied; leading 16px slot reserved.
- **M2.3 Status dots** — **done.** `ThreadStatusDot` + priority tests.
- **M2.4 Date grouping** — **done.** Opt-in “Today / Yesterday / This week / Earlier”.
- **M2.5 Empty projects + “Threads” label** — **done.** Empty project = header only; project-mode root list is “Unorganized”.
- **M2.6 Badges agree** — **left.** Tasks rail vs page counts.
- **M2.7 Icon audit** — **left.**

## Phase 3 — Sidebar II

- **M3.1 Working-set view** — **done.** Pinned / Active / Recent; per-project older disclosure; live work never capped.
- **M3.2 Pinning UX** — **done.** Menu pin, max 5, serialized replace, drag-pin uses same policy.
- **M3.3 Auto-archive automation** — **left.** No weekly automation.
- **M3.4 Home Continue** — **done.** Three slots: live first, then recent idle.

## Phase 4 — Session chrome

- **M4.1 Mono commands + tabular durations** — **partial.** Some timeline/command styling; not a full mono/duration column pass.
- **M4.2 Aligned conversation column** — **left.**
- **M4.3 Composer chrome unification** — **left.** Existing chrome preserved, not redesigned.
- **M4.4 Header hierarchy** — **left.** Review/Switch/Commit not collapsed.
- **M4.5 PageShell adoption** — **left.**
- **M4.6 Loading/empty/error everywhere** — **left** except Inbox (M0.6).
- **M4.7 Right panel tab strip polish** — **partial.** Files tab exists (M6.1); porcelain/copy/toggle unification **left**.
- **M4.8 Message hover actions** — **done.** Copy + one primary + overflow (`MessageActionBar`).
- **M4.9 Shortcut overlay (`?`)** — **left.**
- **M4.10 Undo toasts for delete** — **partial.** Archive already has Undo; delete confirm still there.
- **M4.11 Light-mode sweep** — **partial.** Contrast tokens fixed; leftover literal/pill audit **left**.

## Phase 5 — Palette + plugin kit

- **M5.1 Command palette** — **done.** `CommandPalette.tsx`, ⌘K, fuzzy commands + thread search.
- **M5.2 Zero-result → ask agent** — **done.** “No matches — ↵ to ask the agent”.
- **M5.3 Plugin UI kit (`experimental_*`)** — **left.** Needs SDK prefix + authoring-docs + SKILL in one change.
- **M5.4 Migrate first-party plugins** — **left.** Depends on M5.3.

## Phase 6 — Files + Monaco

- **M6.1 File tree tab** — **partial.** Files panel browses workspace paths. Not virtualized; empty query no longer 400s. Git-status dots incomplete.
- **M6.2 Monaco** — **left.**
- **M6.3 Quick-open (⌘P)** — **partial.** NewTabFileSearch already existed; not wired as full ⌘P → Monaco.
- **M6.4 Editing + `host.write_file`** — **left.** Requires `HOST_DAEMON_PROTOCOL_VERSION` bump.
- **M6.5 Path → reveal-in-tree / dirty tabs** — **left.**

## Phase 7 — Rail + responsive

- **M7.1 Compact 56px icon rail** — **left.** A fake `collapsible="icon"` attempt was **reverted**.
- **M7.2 Two-pane session browser** — **left.**
- **M7.3 Responsive / narrow panel** — **partial.** Auto-collapse standalone secondary panel when conversation is narrow. No <1024 compact rail.
- **M7.4 Density preference** — **left.**

## Phase 8 — Polish catalogue

- **M8.1 Copy affordance** — **partial.** SHA copy on git action dialog; not everywhere.
- **M8.2 Formatters** — **left.**
- **M8.3 Copy standard** — **left.**
- **M8.4 Optimistic rows** — **left.**
- **M8.5 Scroll-position-as-state** — **left** (collapse persistence already existed).
- **M8.6 Title-bar agent state** — **done.** Document title while working.
- **M8.7 aria-live** — **left.**
- **M8.8 Panel-resize feedback** — **left.**
- **M8.9 First-run / what’s new** — **left.**
- **M8.10 Model picker** — **partial.** Labeled provider tabs with scroll + truncate. No context-window/speed hints or reasoning-scale redesign.
- **M8.11 Extensions de-marketing** — **left.**
- **M8.12 Plugin polish (with M5.4)** — **left.**

---

## Suggested next slices (if we continue)

1. **M6.2 + M6.4** — Monaco + write RPC (protocol bump). Biggest product jump.
2. **M7.1** — real compact rail (not shadcn icon collapse).
3. **M5.3 + M5.4** — plugin UI kit, then Board/Recall/Traces.
4. **M3.3** — idle-thread auto-archive automation.
5. **M8 leftovers** — onboarding, formatters, aria-live, picker hints.

## Architecture notes (unchanged)

Provider switch is in-place (does not add sidebar rows). Plugin pages need `experimental_` SDK members + authoring-docs test + SKILL.md. New host RPC must bump `HOST_DAEMON_PROTOCOL_VERSION`. Never `pnpm reset` in `~/bb`.
