# Version — samirhvbr fork of Radiant

**Current version:** `0.1.0`
**Upstream:** `0.7.3` — templetongroup/radiant @ `25d44ba` (`master`, at tag `v0.7.3`)

The **first semver in this file is ours**, and that is not cosmetic: the hooks,
`release.sh` and `fleet.sh` all read the first semver
([ADR-012][adr]). Pointing that at `0.7.3` would hand our tooling a number we do
not control, cannot bump, and that moves on somebody else's schedule — including
backwards, when an upstream reverts ([ADR-023][adr]). Radiant is a fast-moving
upstream: it cut four releases on 2026-09-08 alone.

**No package string.** `package.json` is `"private": true` and this fork
publishes to no registry, so no package manager needs a derived
`<upstream>+<prefix>.<ours>` identifier. If one is ever needed, it is derived
from the two lines above and it is never the first semver in this file.

**The upstream's own version field is theirs and is not edited here** — the
`version` field in `package.json` still reads `0.7.3`. Editing it conflicts on
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
