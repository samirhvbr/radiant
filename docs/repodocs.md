# repodocs — the standard this fork follows, and where it deliberately stops

> **Status:** `ACTIVE` · What this repository adopted from the fleet standard,
> what it did not, and why each divergence is deliberate rather than an
> oversight.

This repository is a **fork of [templetongroup/radiant](https://github.com/templetongroup/radiant)
that we own**. Both halves of that sentence carry weight: we own the remote and
we push to it, and the code, the license and the release history are the
upstream's. The rule for exactly this case is
[ADR-023][adr] in
[samirhvbr/repodocs](https://github.com/samirhvbr/repodocs) — *a fork we own has
a version of its own, and records the upstream point it sits on.*

**repodocs is a source of consultation, not a dependency.** It is never a
submodule, never vendored. Nothing here installs it and nothing here breaks when
it moves.

## Why this file exists at all

An undocumented divergence reads as a mistake to the next person and gets
"fixed" back. This fork diverges from the skeleton in ten places on purpose,
and in a fork the cost of a wrong "fix" is not untidiness — it is a merge
conflict on **every** sync with the upstream, forever. Radiant releases several
times a day, so "every sync" is not a figure of speech here.

## 1. What was adopted

| What | Why it was safe |
|---|---|
| [`../version.md`](../version.md) | The fork had **no version of its own at all**. Added at `0.1.0` — our history begins where our changes begin, not at the upstream's `0.7.3` (ADR-023 §1) |
| `upstream` remote | Mandatory under ADR-023 §7. The only mechanical record of provenance |
| [`../.continue/`](../.continue/) | The queue. Purely additive, and not ignored by the upstream's `.gitignore` |
| `docs/repodocs.md` (this file) | The record of the divergences below |
| `shv-v` tag prefix | Declared in [`../version.md`](../version.md) under ADR-023 §6, because the upstream owns the `vX.Y.Z` namespace and cuts a Release into it |

**One item of the standard is adopted but not yet landed: `.claude/`.** The
repository was born without a permission posture — the upstream's `.claude/`
holds only its own `skills/`. Ours is additive and belongs here, but the folder
is ignored by the upstream's `.gitignore` (see §2), so the files have to be
force-added, and writing a permission posture is the owner's act rather than the
agent's. It is on the queue in
[`../.continue/README.md`](../.continue/README.md) and arrives in its own
version. **Until it does, this repository has no project-level permission
posture** — treat that as the open item it is, not as a decision.

## 2. What was NOT adopted, and what would have broken

**Merge rule, non-negotiable: never overwrite a file the repository already had
because the skeleton has one with the same name.**

| Skeleton file | What is here instead | What adopting it would have cost |
|---|---|---|
| `LICENSE` (MIT, `Copyright (c) 2026 Samir Hanna Verza`) | **`LICENSE` — MIT, `Copyright (c) 2026 Templeton Technologies`**, the upstream's | Same license, **different copyright holder**. Overwriting it would put our name on somebody else's copyright — the conformance check `diff LICENSE repodocs/LICENSE` will never pass here, and must not. The one-line difference is exactly the line that matters |
| `NOTICE` | Nothing — the upstream ships none | A `NOTICE` we authored would be **our** claim about **their** dependency tree, maintained by us and drifting from a `package-lock.json` we do not control. Their MIT terms already carry the attribution they require |
| `version.md` as the only version | `package.json` still reads `0.7.3` | That is the **upstream's own version field**. Editing it conflicts on every sync — the one thing both self-versioning forks in the fleet got right from the start (ADR-023 §3) |
| `CHANGELOG.md`, each `##` a commit subject | No changelog file; our record lives inside [`../version.md`](../version.md) | The upstream keeps no changelog at all — its history is the commit log and its GitHub Releases. A `CHANGELOG.md` at the root of a fork reads as *the project's* changelog. A changelog inside `version.md` is the sanctioned case — [runbook §8][runbook] says nothing is written and no second file is created |
| `CLAUDE.md` + `AGENTS.md` twins, with the three echo blocks | The upstream's `CLAUDE.md` (a one-line `@AGENTS.md` pointer) and its `AGENTS.md` | `AGENTS.md` is **their** agent context — it opens on the iPhone app's App Store Connect status and binds to Tony's build history. Stamping echo blocks into it conflicts on every sync, and the twins rule would have us overwrite the pointer too |
| `.gitignore` | The upstream's, **unedited** | It ignores `.claude/`; the upstream then force-adds `.claude/skills/**` anyway. Our own `.claude/` files will be force-added the same way rather than by editing the rule. Un-ignoring `.claude/` would also un-ignore a `settings.local.json` that must never be committed |
| `SECURITY.md` | Nothing | It would name **us** as the reporting path for a vulnerability in **their** code. A report about Radiant belongs at the upstream; a `SECURITY.md` here would silently misroute it |
| `tools/git-hooks/` + `core.hooksPath` | Not installed | The upstream's subjects are prose sentences — *"The window could not be dragged from the Task, Loop or Graph tabs"*. `commit-msg` would **refuse every commit this fork is about to receive** ([runbook §8][runbook]) |
| `.github/workflows/release.yml` + `tools/release.sh` | Not installed | It publishes. Cutting GitHub Releases on a fork of somebody else's project, into a version namespace that is theirs and that moves several times a day |
| `README.md` | The upstream's | It describes the product accurately. A second README answering the same question is the failure mode; the fix is not a third |

## 3. How this fork graduates

Nothing above is permanent. `fleet.sh` classifies a repository as
upstream-shaped by reading whether **the last five commit subjects are ours**.
Once they are, this fork stops being skipped and receives the hooks and the echo
blocks like any other repository — automatically.

**The heuristic is the adoption test, and there is no list to maintain.** Until
then `fleet.sh check` still reads this repository, in its `FORKS WE OWN`
section, where it verifies exactly four things:

- `version.md` exists
- its first semver is **ours**, not an upstream number in a local-version string
- it says which upstream point the fork sits on
- an `upstream` remote is configured

All four hold as of `0.1.0`.

The items that would still not follow after graduation are `LICENSE`, the absent
`NOTICE` and the absent `SECURITY.md` — those are permanent, for the reasons in
§2.

## 4. Contributing back to the upstream

**None of this governs what we write into `templetongroup/radiant`.** A pull
request or an issue there follows **their** language and **their** commit shape,
not ours ([ADR-019][adr] and
[conventions.md §8](https://github.com/samirhvbr/repodocs/blob/master/docs/conventions.md#8-language)).
Their subjects are full sentences describing the change from the user's side, with
no version prefix — our `X.Y.Z - description` subject reads as noise in a
repository that has no `version.md` of ours, and there is no version there for us
to bump.

Check before writing: a written instruction first — here that is
[`../RULES.md`](../RULES.md) and [`../AGENTS.md`](../AGENTS.md) — then the last
~20 merged pull requests, then the issues, then the commit log. When it cannot be
determined, English (US).

## 5. Where each question is answered

| Question | Where |
|---|---|
| What is the documentation norm? | [repodocs `docs/conventions.md`](https://github.com/samirhvbr/repodocs/blob/master/docs/conventions.md) — the single source; never copied here |
| How does a fork version itself? | [repodocs `docs/versioning.md`](https://github.com/samirhvbr/repodocs/blob/master/docs/versioning.md#a-fork-we-own-versions-itself) and [ADR-023][adr] |
| What version is this, and of what upstream point? | [`../version.md`](../version.md) |
| What is still open here? | [`../.continue/README.md`](../.continue/README.md) — the queue, read first |
| What does the product do? | The upstream's [`../README.md`](../README.md) |
| How does the upstream want to be worked in? | The upstream's [`../AGENTS.md`](../AGENTS.md) and [`../RULES.md`](../RULES.md) |

[adr]: https://github.com/samirhvbr/repodocs/blob/master/docs/decisions.md
[runbook]: https://github.com/samirhvbr/repodocs/blob/master/docs/runbook.md
