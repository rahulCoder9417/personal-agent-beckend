# Optimization log: what changed in the backend and the vm-manager

This file records every change made to the backend and the vm-manager while we optimize the product, starting on 13 October 2026. Each change is written up by feature, in plain words, with no code. An entry says what changed and why, what it means for users and for cost, how it was checked, and where it is now.

This file does not replace the other docs. `hld-mvp.md` is still the design and `backend-report.md` still explains the logic. When a change alters how something works, those two files are updated as well, and the entry here says which sections.

## Contents

1. [In short](#1-in-short)
2. [The starting point](#2-the-starting-point)
3. [How an entry is written](#3-how-an-entry-is-written)
4. [The log](#4-the-log)

---

## 1. In short

| | |
|---|---|
| **What it covers** | The backend (api and worker) and the vm-manager (the containers, the Bridge, the egress proxy) |
| **Started** | 13 October 2026 |
| **Order** | Newest change first |
| **Where the work is done** | The branch `claude/determined-ride-icigwz` in both repos |
| **How it reaches `main`** | A pull request that you merge |
| **How it reaches the server** | After it is on `main`, by running `/opt/textcrew/deploy.sh` on the server (see `aws-setup.md`, section 8) |

---

## 2. The starting point

Both repos start from `main` as it was on 9 October 2026:

| Repo | Last change on `main` | Commit |
|---|---|---|
| Backend | Replies as Markdown in the web app and as plain text on Telegram | `6f9cb52` |
| vm-manager | The agent is told how to format its answer for each channel | `bbe8f05` |

What worked on the test server at that point, what was built but never run for real, and the decisions waiting on you are in `hld-mvp.md`, section 12. Every entry below is a change from that point.

---

## 3. How an entry is written

Each entry has a heading with the date and the name of the feature, then the parts below. A part that does not apply is left out.

- **Where it is:** on the branch, on `main`, or on the test server, with the date it got there. This is updated as the change moves along.
- **Why:** the problem or the goal behind the change.
- **What the user notices:** what changes for someone using Textcrew. "Nothing" is a fine answer for a change on the inside.
- **Backend:** what changed in the api or the worker, in words.
- **vm-manager:** what changed in the containers, the Bridge or the egress proxy, in words.
- **Cost and speed:** what the change does to our bills, to users' credits, to the memory a container uses, or to how fast a reply comes. Numbers when they were measured, and "not measured" when they were not.
- **Contracts:** whether the REST contract (`openapi.yaml`) or the contract with the vm-manager (`vm.proto`) changed. A changed contract means the web app or the backend has to follow.
- **Database:** new or changed tables, or "none".
- **How it was checked:** the tests added and their real results, and whether it has run on the test server.
- **Still open:** what is left to do, or what needs your decision.
- **Docs updated:** the sections of `hld-mvp.md` and `backend-report.md` that were changed.
- **Commits:** the short commit ids in each repo, so the change can be found later.

---

## 4. The log

### 13 October 2026: every Claude model in Settings

- **Where it is:** on `main` since 13 October. Not on the server yet: the agent image has to be rebuilt there.
- **Why:** with a Claude plan connected, the Model choice offered only four models, and one of them (Haiku 4.5) was out of date.
- **What the user notices:** the Model choice now lists every model Claude Code can use. The four current ones (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1) come first under one heading. The nine older ones Claude still offers come under a second heading. The effort choice offers only the levels the chosen model takes, and is greyed out for the two models that take none. Both Fable models carry a note: on Pro they are paid with usage credits, and on Max they may use up to half the weekly limit before credits.
- **Backend:** the list of models is kept by hand in one place, because Claude has no way to tell an app which models a plan allows. Each model now says its group (current or older), its effort levels, and an optional note. Choosing an unknown model is still refused, and a saved model later taken off the list still reads as "Default".
- **vm-manager:** the agent image now installs Claude Code 2.1.296 instead of 2.1.283. The old version did not know Sonnet 5.5 or Haiku 5.5. The Bridge needed no change: it already passes any well-formed model name to Claude Code.
- **Cost and speed:** no change for us. A user who picks Fable on a Pro plan spends their own Claude usage credits without being asked again, because Claude Code works that way when it runs without a screen. The note warns them before they pick it.
- **Contracts:** `openapi.yaml` gained three fields on each model choice (group, effort levels, note). The change only adds fields. `vm.proto` did not change.
- **Database:** none.
- **How it was checked:** new tests save every model and check it reaches the turn, check the list's shape, and send all 13 names through the Bridge to Claude Code. Backend, web app and vm-manager checks pass. The 13 names and their effort levels were checked against Anthropic's model pages and against the model table inside Claude Code 2.1.296 itself.
- **Still open:** the agent image has not been built with 2.1.296 (its download could not be checked from the cloud machine), and no real turn has run on it yet. Whether a given plan really allows each older model has not been tried.
- **Docs updated:** `backend-report.md` (the Claude Code model and effort part), `hld-mvp.md` section 2, the vm-manager's README and build report, and the web app's README.
- **Commits:** backend `2c00d15`, `5c2a38b`, `3ae170a`; vm-manager `6504752`, `bb742c1`, `47d0290`; web app `ff453a6`, `47b02c9`, `931a63e`, `afe22d5`.
