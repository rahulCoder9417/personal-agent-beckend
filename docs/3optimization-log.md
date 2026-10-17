# Optimization log 3 (from 17 October 2026): what changed in the backend and the vm-manager

This file records every change made to the backend and the vm-manager from 17 October 2026 on. It takes over from `2optimization-log.md`, which holds the entries of 16 October and is no longer added to. The older entries are in `1optimization-log.md` and `optimization-log.md`, also closed. Each change is written up by feature, in plain words, with no code. An entry says what changed and why, what it means for users and for cost, how it was checked, and where it is now.

Only the backend and the vm-manager are logged here. Changes made only to the web app's screens are not; the web app's README describes those.

This file does not replace the other docs. `hld-mvp.md` is still the design and `backend-report.md` still explains the logic. When a change alters how something works, those two files are updated as well, and the entry here says which sections.

## Contents

1. [In short](#1-in-short)
2. [How an entry is written](#2-how-an-entry-is-written)
3. [The log](#3-the-log)

---

## 1. In short

| | |
|---|---|
| **What it covers** | The backend (api and worker) and the vm-manager (the containers, the Bridge, the egress proxy) |
| **What it leaves out** | Changes made only to the web app's screens |
| **Started** | 17 October 2026. Earlier entries are in `2optimization-log.md`, `1optimization-log.md` and `optimization-log.md`, all closed |
| **Order** | Newest change first |
| **Where the work goes** | Straight to `main` in each repo, once the checks pass |
| **How it reaches the server** | By running `/opt/textcrew/deploy.sh` on the server (see `aws-setup.md`, section 8) |

---

## 2. How an entry is written

Each entry has a heading with the date and the name of the feature, then the parts below. A part that does not apply is left out.

- **Where it is:** on `main` or on the test server, with the date it got there. This is updated as the change moves along.
- **Why:** the problem or the goal behind the change.
- **What the user notices:** what the backend or vm-manager change means for someone using Textcrew. "Nothing" is a fine answer for a change on the inside.
- **Backend:** what changed in the api or the worker, in words.
- **vm-manager:** what changed in the containers, the Bridge or the egress proxy, in words.
- **Cost and speed:** what the change does to our bills, to users' credits, to the memory a container uses, or to how fast a reply comes. Numbers when they were measured, and "not measured" when they were not.
- **Contracts:** whether the REST contract (`openapi.yaml`) or the contract with the vm-manager (`vm.proto`) changed. A changed contract means the web app or the backend has to follow.
- **Database:** new or changed tables, or "none".
- **How it was checked:** the tests added and their real results, and whether it has run on the test server.
- **Still open:** what is left to do, or what needs your decision.
- **Docs updated:** the sections of `hld-mvp.md`, `backend-report.md` and the vm-manager's docs that were changed.
- **Commits:** the short commit ids in the backend and the vm-manager, so the change can be found later.

---

## 3. The log

### 17 October 2026: Tex knows who you are in your apps (no more "what is your GitHub username?")

- **Where it is:** on the branch `fix/app-account-identity` in the backend and the vm-manager, made on top of "apps before Scout" (below), not on `main` yet, and not on the test server.
- **Why:** you said: "whenever I go for the repo it asks for user name. Doesn't the integration list it? If not, only ask one time and add that to the memory of Tex." What happened, from the database (read only): at 05:11 Tex asked for your GitHub username, at 05:17 you gave it (rahulcoder9417), and at 07:22, in a new chat, Tex asked again for the owner of "code smith". Three things together:
  - Tex did look at your apps (`get_profile` at 05:09 and at 07:21), but the GitHub entry said `account: null`. Every connection on the server had an empty account label, Gmail's too: the label was read from Composio's record of the account (its email), and Composio's record does not hold one.
  - The action that gives the username, `GITHUB_GET_THE_AUTHENTICATED_USER`, was searched for ("get authenticated user", "authenticated user") but not found: GitHub's list stopped at 200 actions. "Apps before Scout" fixed that list.
  - Nothing told Tex to keep the username it was given. Your memory had no entry at all, and a new chat starts without the earlier one.
- **What the user notices:** Tex does not ask for your GitHub username or your Gmail address: it knows them from the connection, from its first look at your apps. A repository you name without its owner ("code smith") is looked for among your own. The Integrations page shows who GitHub and Gmail are connected as. For an app that cannot say who you are, Tex asks once, saves the answer to your memory (you see it under Memory), and uses it from then on.
- **Backend:**
  - Each app in the catalog may name its own "who am I" action and the field that holds the account: GitHub `GITHUB_GET_THE_AUTHENTICATED_USER` (`login`), Gmail `GMAIL_GET_PROFILE` (`emailAddress`). Both only read. The other apps have none for now.
  - The first time Tex looks at your apps (`get_profile` or `list_app_actions`) and an active connection of such an app has no label yet, the api runs that action for your own connection, with your user id, and keeps the answer as the connection's account label. Two calls at once ask once. The platform runs it, not Tex: nothing is charged and it is not in the activity log.
  - `get_profile` gives each connected app with `account`, and `list_app_actions` now gives `account` for each connected app too (the connection its actions run on, the newest). Null means the app does not say. The tool's description says what `account` is and to use it instead of asking.
  - Tex's answer waits at most 3 seconds for the app. A slower answer is still kept when it comes. A failed one, or one that does not say, is asked again 10 minutes later at the soonest.
  - The ops script's `apps` command shows it ("agent sees github: connected as …").
- **vm-manager:** a new paragraph in Tex's instructions, on both engines, right after the memory rules: use the app's account from `get_profile` or `list_app_actions` and never ask for a username, email or account in a connected app; a repository named without its owner is most likely the user's own; when the account is null, ask the app (`GITHUB_GET_THE_AUTHENTICATED_USER`); only when the app cannot tell, use `recall`, and if it is not saved, ask the user once and save the answer with `remember`.
- **Cost and speed:** one read-only Composio call per GitHub or Gmail connection, once, and nothing after that. The first look at the apps after connecting may take up to 3 seconds longer, once (not measured on the server; Composio's key is there only). The instructions grow by about 750 characters per turn (measured: 748), in the part the prompt cache keeps.
- **Contracts:** `openapi.yaml` describes `accountLabel` (the user's app list and the admin's): who the connection is signed in as, an email or a GitHub username, null until known. Its shape is unchanged, so the web app needs no change and already shows it. `vm.proto` is unchanged.
- **Database:** none. The label goes in the `connections` table's existing account label.
- **How it was checked:** backend: a new test file. GitHub's account is asked with GitHub's own action, for the user's own connection, shown in `list_app_actions` and `get_profile`, kept, and not asked again; the Integrations list shows it; listing "my repositories" runs with no username at all; Gmail's address is read from inside Composio's wrapper; an app without such an action is not asked and shows null; a failed lookup leaves no label, does not stop the tool, and is asked again after 10 minutes; a slow one does not hold up the answer and is kept when it comes; a known label is never asked for or replaced. Three existing tests now expect the new `account` field. Lint, type check and the whole suite pass, after "apps before Scout" was merged (104 files, 1,207 tests). vm-manager: two new Bridge tests (the rule's parts, once in every kind of turn and a crew job's, right after the memory rules; and both Hermes and Claude Code get it), all 279 Bridge tests pass, and the Go build, vet and tests pass. The server's logs were not read: SSH to the server timed out from here (the server's SSH rule probably needs your new home address).
- **Still open:**
  - The deploy (below). After it, the first time Tex looks at your apps, your GitHub and Gmail get their account; nothing needs doing by hand.
  - **Connecting the same account again** (the clean-up job of section 14) compares these labels. It still finds no match right after a reconnect, because the new connection gets its label only when Tex first looks, usually after the job has run; then both connections stay, as before. Asking the app in that job too would make the clean-up work for GitHub and Gmail as designed. It removes old connections, so it is left for your decision.
  - More apps could say who you are the same way (Slack, Notion, Linear and others have such actions). Each needs its action and field checked against Composio first; for now Tex asks once and saves it.
  - Also seen in the same chat, not fixed here: at 07:26 and 07:28 `GITHUB_LIST_PULL_REQUESTS` and `GITHUB_LIST_REPOSITORIES_FOR_A_USER` failed with "the app returned an error", and Tex said a field was missing although it had given it. The server's log would say why; it could not be read.
- **Deploy:** the backend (`/opt/textcrew/deploy.sh`) and a new agent image for the instructions. Either can go first: the old instructions ignore `account`, and the new ones work without it (Tex asks the app).
- **Docs updated:** `backend-report.md`: the tools table (`get_profile`, `list_app_actions`), section 14 (a new part "Who an app is connected as", "Connecting the same account again" step 2, where the keys stay, and what can go wrong), section 22 (when to save who the user is in an app), section 34 (a fourth rule for the lead). `hld-mvp.md`: 5.3 (who the user is in an app) and section 12.
- **Commits:** backend `cdcc010` (the contract's words), `418e503` (the code and tests) and the docs commit after them; vm-manager `3826157`.

### 17 October 2026: apps before Scout (Tex finds GitHub's pull requests in the app, not on github.com)

- **Where it is:** on the branch `fix/apps-before-scout` in the backend and the vm-manager, not on `main` yet, and not on the test server.
- **Why:** in web chat you asked Tex "tell me about open pr". Tex asked which repository, then your GitHub username, then said GitHub had no action to list pull requests, and on your username sent Scout to read github.com: your profile and 20 repositories' pull-request pages, one by one, while "Tex is working" stayed on. You asked why Scout was used. What happened, from the activity log of that chat: Tex searched GitHub's actions about 30 times in three turns ("pull request", "list pull requests", "pulls", "search issues", "repos for authenticated user", "get authenticated user" and more) and every time found only actions that create, close or check one pull request. GitHub has about 900 actions at Composio, and Composio lists them in alphabetical order. The api asked for 200, so GitHub's list stopped in the Cs: every action that finds, gets, lists or searches was missing, the ones for pull requests, your repositories and your username among them. A search only looked inside those 200, and it also had to find the words exactly as typed ("list pull requests" is not in "Lists pull requests for a GitHub repository"). So the app could do it, but the list hid it. A day earlier, in your "Daily Pending PR Email" automation's run, Tex had guessed `GITHUB_LIST_PULL_REQUESTS` by its name and it worked. Tex's instructions also said "anything that needs the web goes to Scout" and nothing about using the app first, so once it believed the app had no action, Scout was its next step. Scout reads github.com as a stranger: it said "all 28 public repos were checked" and it cannot see private ones (the automation's run had found a pull request in `personal-agent-beckend`, which Scout's list did not have).
- **What the user notices:** asked about their pull requests, repositories or issues, Tex uses the connected GitHub app: faster, cheaper, and private repositories included. It no longer asks for a username or a repository the app can tell it. If an app truly has no action for a job, Tex says so and asks before sending Scout to the public website.
- **Backend:**
  - The api asks Composio for up to 1,000 actions of one app, Composio's largest page, instead of 200: the whole of GitHub (about 900) and every other app. A full page of 1,000 is written to the server log, so we know if an app ever grows past it.
  - `list_app_actions` searches all of the app's actions and looks at each word of the search, in the action's name and in its description. Small words are left out, plural endings don't matter, and "PR" means pull request. The actions with every word come first, those with the words in their name first of all. When no action has every word, the closest ones are shown with a note; when none matches, a note suggests other words. In a search across apps, an app with only some of the words stays out when another has them all.
  - The tool's description tells the agent to search by app and plain words, and to try other words before deciding the app cannot do it.
  - The step panel's list of an app's actions (automations) comes from the same listing, so it now has all of GitHub's actions too.
- **vm-manager:** the Bridge's instructions for Tex, on both engines:
  - The app rules say the user's own data in a connected app comes from the app's actions, never from the app's website, how to search for an action, and name three GitHub actions: `GITHUB_FIND_PULL_REQUESTS` (pull requests across the user's repositories), `GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER` and `GITHUB_GET_THE_AUTHENTICATED_USER` (the username). Tex is told not to ask the user for what the app can tell it.
  - The crew rules say apps come before Scout: such a job is not a web job, Tex does it with the app, Scout only when no connected app can do it, and Tex asks the user before sending Scout to an app's public website. A change to a repository's code still goes to Byte and a review to Patch.
  - Scout's description, which Claude Code reads to pick a helper, says it is not for the user's own data in a connected app.
- **Cost and speed:** fewer wasted rounds and no Scout run for such questions: on 17 October that one question cost three turns, about 30 searches and a Scout run of 21 page reads. The first `list_app_actions` for GitHub after 10 minutes now fetches about 900 actions instead of 200, a bigger answer from Composio, kept 10 minutes for every user (not measured; Composio's key is on the server only). The instructions grow by about 1,400 characters per turn (measured: 1,441), in the part the prompt cache keeps.
- **Contracts:** none. `openapi.yaml` and `vm.proto` are unchanged.
- **Database:** none.
- **How it was checked:** backend: a new test file with a GitHub list shaped like Composio's (about 900 actions in alphabetical order, the real pull-request actions with their real descriptions). It reproduces 17 October: with the list cut at 200, "pull request" finds only the check, close and create actions. With the fix, every search Tex tried that day finds a way to list pull requests or the user's repositories, "list pull requests" puts `GITHUB_LIST_PULL_REQUESTS` first, the found action is described from the same listing, and the notes and the search across apps behave as above. A test checks that Composio is asked for 1,000. The existing test of the fair shares now expects all 320 of its fake GitHub actions to be counted. Lint, type check and the whole test suite pass (103 files, 1,200 tests). One earlier full run had one failure in an unrelated timing test (waking a container, 1.07 seconds under load); it passed alone and in the next full run. vm-manager: two new Bridge tests (both engines get the app rule and the GitHub actions; the crew rule and Scout's description), all 277 Bridge tests pass, and the Go build, vet and tests pass. The server's logs were not read: SSH to the server timed out from here (your home address has probably changed, so the server's SSH rule needs your new address).
- **Still open:** the deploy (below). Not done, as a proposal: Composio marks some actions of each app as "important" (its featured ones). Listing those first when the agent asks for an app with no search word would make the first 100 of GitHub's 900 useful instead of alphabetical ("Abort repository migration", "Accept a repository invitation", …). It costs one more request to Composio per app every 10 minutes; your call.
- **Docs updated:** `backend-report.md`: "How the agent finds and runs an action" (steps 1 and 3, with the 17 October example), the approval check's "Where the list comes from", the step panel's "An app's actions", the lead's instructions (a third rule) and "The crew, as defined in the container" (apps come before Scout). `hld-mvp.md`: 5.7 (Research and the browser) and section 12.
- **Commits:** backend `9563d19` (the code and tests) and the docs commit after it; vm-manager `7b9f705`.
