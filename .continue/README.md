# `.continue/` — the queue

> **Status:** `ACTIVE` · Last reviewed 08/09/2026, repository at 0.1.0

Work in progress: drafts, plans under discussion, notes on things still being
built, briefings for picking the work back up later.

**The norm this folder obeys lives once, in the fleet standard:**
[samirhvbr/repodocs `docs/conventions.md`](https://github.com/samirhvbr/repodocs/blob/master/docs/conventions.md)
— §1 (queue vs. record) and §2 (this README is mandatory). Read it there; a copy
here would be a second source of truth.

## How it works

- **Git-tracked on purpose — deliberately NOT in `.gitignore`.** Opening the
  project on another machine brings the context along, which is the whole point:
  you can *continue* from where you stopped.
- **Nothing here is source of truth.** The moment a document describes something
  that already exists, it moves to [`../docs/`](../docs/) and the permanent
  record of *when* is [`../version.md`](../version.md) — in this fork our
  changelog lives there, because the upstream keeps no changelog file and a
  `CHANGELOG.md` at the root of a fork would read as the project's own
  ([`../docs/repodocs.md`](../docs/repodocs.md)).
- **A finished item leaves — and *finished* means the thing exists.** It is
  deleted here, not ticked off; the permanent record of completion is the
  changelog. A queue holding an already-done item costs more than an incomplete
  queue: it makes the next session redo work.
- **Nothing leaves for any other reason.** Not length, not language, not a
  session ending, not an agent who would have written it differently. **To
  produce an item is to make the thing exist**, and deleting the document is the
  last step of the commit that carries the work — never a step of its own.
- **If an item needs half a page to describe something that already exists**, it
  is in the wrong place. Write it in `../docs/` and leave one line and a pointer
  here.
- **In a contradiction between this folder and a document in `../docs/`, the
  document wins.**
- **An item about the upstream's code is not automatically ours to do.** Radiant
  moves several times a day; before queueing a fix here, check whether it belongs
  as a pull request over there instead
  ([`../docs/repodocs.md`](../docs/repodocs.md) §4).
- The **Continue** IDE also uses this folder for its own configuration.

## 1. What is left here

<!-- One line per item. Delete a row when the item is done — do not tick it. -->

| Item | State | Who unblocks it |
|---|---|---|
| The `.claude/` permission posture | Not written. `.claude/` is a protected path, so the agent cannot create `settings.json` there without the owner's approval — and the upstream ignores the folder, so both files then need `git add -f`. Copy them from the [repodocs skeleton](https://github.com/samirhvbr/repodocs/tree/master/templates/skeleton/.claude), naming the project *Radiant (samirhvbr fork)* | Samir |

## 2. Where things went

<!-- When a document leaves for ../docs/, give it a row with a relative link.
     This is what keeps "it misleads whoever opens it" from becoming "nobody
     can find it". -->

| It was here | It is now at |
|---|---|
| _(nothing yet)_ | |

## 3. Pending decisions

| Decision | Whose | Note |
|---|---|---|
| Whether this fork ever ships a build of its own | Samir | It would need the `shv-v` tag prefix already declared in [`../version.md`](../version.md), and a signing story the upstream's `build/` does not hand us |
