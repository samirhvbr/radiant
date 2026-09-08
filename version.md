# Version — samirhvbr fork of Radiant

**Current version:** `0.2.0`
**Upstream:** `0.8.0` — templetongroup/radiant @ `ec27c82` (`master`, at tag `v0.8.0`)

The **first semver in this file is ours**, and that is not cosmetic: the hooks,
`release.sh` and `fleet.sh` all read the first semver
([ADR-012][adr]). Pointing that at `0.8.0` would hand our tooling a number we do
not control, cannot bump, and that moves on somebody else's schedule — including
backwards, when an upstream reverts ([ADR-023][adr]). Radiant is a fast-moving
upstream: it cut sixteen releases on 2026-09-08 alone.

**No package string.** `package.json` is `"private": true` and this fork
publishes to no registry, so no package manager needs a derived
`<upstream>+<prefix>.<ours>` identifier. If one is ever needed, it is derived
from the two lines above and it is never the first semver in this file.

**The upstream's own version field is theirs and is not edited here** — the
`version` field in `package.json` reads whatever the upstream last set — `0.8.0`
at the time of writing, and it will have moved again. Editing it conflicts on
every sync, which is the one thing the two forks that versioned themselves before
this rule got right from the start.

**Tags carry a prefix, because the namespace is not ours.** The upstream tags
`vX.Y.Z` and cuts a GitHub Release for each. Our tags are `shv-vX.Y.Z`, declared
here as ADR-023 §6 requires, so nothing we cut can collide with or shadow one of
theirs.

**A sync is a delivery.** Pulling from `upstream` changes what this fork is, so
it bumps the version above and its entry names the upstream point we moved to —
even when not a line of our own code changed.

What this fork keeps from the upstream, what it adds, and why each divergence is
deliberate: [`docs/repodocs.md`](docs/repodocs.md).

[adr]: https://github.com/samirhvbr/repodocs/blob/master/docs/decisions.md

---

## Changelog

The upstream keeps **no changelog file at all** — its history lives in the commit
log and in [their GitHub Releases](https://github.com/templetongroup/radiant/releases).
Our history is kept here rather than in a `CHANGELOG.md` we would have to invent
at the repository root, because a root changelog in a fork reads as *the
project's* changelog and this one only speaks for our side of the remote.

## 0.2.0 — 2026-09-08

Synced to the upstream's `0.8.0` (`ec27c82`), eight versions on from where this
fork sat. A sync is a delivery even when not a line of our own code changed —
and here none did, which is the whole point of this entry.

**Radiant runs on Linux now, and none of that work lives in this fork.** Eight
pull requests were written here and every one was merged upstream:

| | |
|---|---|
| [#5](https://github.com/templetongroup/radiant/pull/5) | `server/platform.js` — one place that knows what machine this is |
| [#6](https://github.com/templetongroup/radiant/pull/6) | the AppImage target, and the Mach-O helper out of the Linux build |
| [#7](https://github.com/templetongroup/radiant/pull/7) | the window keeps its own title bar where we never removed it |
| [#8](https://github.com/templetongroup/radiant/pull/8) | Settings tells the truth about what the machine can do |
| [#9](https://github.com/templetongroup/radiant/pull/9) | the update points at a file this machine can open |
| [#10](https://github.com/templetongroup/radiant/pull/10) | `gnome/radiant-control.cjs` — the agent can drive a Linux desktop |
| [#11](https://github.com/templetongroup/radiant/pull/11) | the UI names the machine it is actually describing |
| [#12](https://github.com/templetongroup/radiant/pull/12) | a Linux release actually reaches somebody |

⚠️ **SO THIS FORK STILL OWNS EXACTLY THREE FILES**, and the diff against the
upstream is still `version.md`, `docs/repodocs.md` and `.continue/README.md`.
That is the outcome [`docs/repodocs.md`](docs/repodocs.md) §4 asks for — an item
about the upstream's code is not automatically ours to do, and a fix that belongs
over there costs nothing here forever. Had these eight landed as local
divergence instead, every one of them would conflict on every sync from now on.

⚠️ **AND IT BREAKS THE GRADUATION HEURISTIC IN §3.** `fleet.sh` classifies a
repository as upstream-shaped by reading whether the last five commit subjects
are ours. They now are — #8 through #12 and the merge — but they are ours only
in the sense that we wrote them; they arrived by pulling somebody else's
`master`. The heuristic would read this fork as having graduated at the exact
moment it proved it had not. Flagged rather than worked around, because the fix
belongs in the standard and not in a special case here.

Nothing in this repository changed except the two lines at the top of this file
and this entry.

## 0.1.0 — 2026-09-08

Fork bootstrapped against the fleet documentation standard
([samirhvbr/repodocs](https://github.com/samirhvbr/repodocs) 1.13.0), at the
first version of our own — our history begins where our changes begin, not at
the upstream's number.

- `version.md`: our version, the upstream point this fork sits on, the `shv-v`
  tag prefix, and our changelog in the one file that decides what a version means.
- `upstream` remote configured — the only mechanical record of provenance, and
  mandatory under ADR-023.
- `.continue/`: the queue, git-tracked on purpose — and it opens holding the one
  thing this version did **not** land: the `.claude/` permission posture. That
  folder is ignored by the upstream, so our files there have to be force-added,
  and writing into it is the owner's act rather than the agent's. It arrives in
  its own version.
- `docs/repodocs.md`: which parts of the standard this fork adopted, which it
  deliberately did not, and what would have broken if it had.

Nothing the upstream owns was touched: `LICENSE` (MIT, Templeton Technologies),
`README.md`, `AGENTS.md`, `CLAUDE.md`, `RULES.md`, `.gitignore` and
`package.json` are all as they came.
