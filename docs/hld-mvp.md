# Textcrew MVP: the design

This file explains what Textcrew is, what its parts are and how they work together. It is written to be read from top to bottom.

Six files make up the docs:

| File | What it holds |
|---|---|
| `hld-mvp.md` (this file) | The product, the parts, the main flows, the decisions, and the steps to launch the beta |
| `backend-report.md` | Every piece of logic in the backend, explained in words, with no code |
| `aws-setup.md` | The test server: what was done, the commands, the problems and their fixes |
| `domain-setup.md` | The domain `textcrew.in`: where it was bought, who answers DNS, each name, and how to add or move one |
| `engines-proposal.md` | A proposal, not built: adding Codex and other bring-your-own engines, with OpenAI's rules and the decisions to make |
| `automations-flow-proposal.md` | A proposal: automations shown and made on a canvas (React Flow), and drafts Tex makes from the chat, with the decisions to make. You chose option A, with C to follow. Phases 1 and 2 are built (section 5.4) |
| `automations-steps-proposal.md` | A proposal, not built yet: automations with up to 6 steps in one run (phase 4), with the decisions to make |
| `optimization-log.md` | Every change made to the backend and the vm-manager while we optimize the product, by feature, in plain words |

**The pictures** are in GoDraw, in the canvas named **"Textcrew MVP: high-level design"**. It has five pages. Each section below says which page shows it.

## Contents

1. In short
2. What a user can do
3. The words used
4. The parts
5. How the main things work
6. AI, three ways
7. Plans and credits
8. The safety rules
9. Decisions made
10. Rules from other companies
11. Not in the MVP
12. Where it stands
13. Launching the beta

---

## 1. In short

| | |
|---|---|
| **What it is** | A personal AI agent that you text. It does real work in your apps and can write and review code |
| **Who it is for** | Developers and tech founders who manage a team |
| **Where you talk to it** | Telegram and a web app |
| **Where the agent runs** | In its own locked container on our server. One container per user |
| **What it can reach** | Your apps (Gmail, GitHub and others), the web, and files in its own container |
| **Who provides the AI** | You: your Claude plan or your own API key. Or us: Textcrew AI, paid in credits |
| **How we charge** | Credits. Plans give credits every month |
| **Stage** | Built and tested on one test server. Not open to users yet |

---

## 2. What a user can do

- **Chat with their own agent.** On Telegram or in the web app. Example: "What is on my calendar today?"
- **Read each reply in the form that fits the place.** In the web app a reply has formatting: headings, bold words, lists, tables and code. On Telegram the same reply is a simple text message, with no formatting symbols. Example: a table in the web app is one line per row on Telegram.
- **Start a new chat.** The "New chat" button in the web app, or the message `/new` on Telegram. The agent then does not see what was said before in that chat. Its saved notes about the user stay. It costs nothing.
- **Keep a history of conversations.** Each new chat is its own conversation, with its own context. The web app lists them, named after their first message. The user can open an earlier web conversation and go on writing in it: the agent continues that conversation, not the latest one. Example: open last week's "Plan a trip to Goa" and ask "and the hotel?". Telegram conversations are in the list for reading.
- **Rename or delete a conversation.** Deleting one removes its messages and files.
- **See what is new.** In the web app's list, a conversation with a message from the agent that the user has not seen yet has a blue dot, a Telegram conversation too. Opening it clears the dot on every device. Writing in a conversation, on Telegram as well, counts as having seen what came before.
- **Get real work done in apps.** The agent can act in about 25 apps. Example: "Email Priya the meeting notes."
- **Stay in control.** Before the agent sends something to another person, deletes something or pays, it asks first.
- **Set reminders and automations.** Once, on a schedule, or when something happens in an app. Example: "Every Monday at 9, send me my open pull requests." Tex shows anything more than a plain reminder as a draft first, drawn as a small diagram, and the user saves it with one tap. Each automation can be seen as a flow on its own page, and built or changed there by hand, box by box. "Run once now" tries one.
- **Use a crew.** The agent you text is called Tex. Tex can hand work to three specialists: Byte writes code, Patch reviews code, Scout researches.
- **Get pull requests reviewed.** Turn it on for a GitHub repo. When a pull request opens, Patch reviews it and comments on it. You get a short verdict in chat.
- **Give the crew a job.** Say it in chat, in plain words: Patch reviews one pull request or branch, or Byte fixes or builds something and opens a pull request. Pick the repo, say what to look for or what to test, give the commands to run, and choose where the report goes. The job runs in a folder of its own, and when it is over, everything it started is stopped and the folder is deleted. Example: "Patch, review acme/web PR 42, run pnpm test, post it on the PR."
- **Research on the web.** Scout searches and reads pages. On the Max plan Scout can also drive a real browser.
- **Be remembered.** The agent keeps short notes about you, and you can see and delete them.
- **Bring their own AI.** A Claude plan or an API key. Then the AI part costs no credits.
- **Choose Claude's model and effort.** With a Claude plan, the user picks the Claude model and how hard it thinks, called the effort. Every model Claude Code can use is offered: the current ones first, then the older ones Claude still runs. Example: Opus 5.5 at effort "xhigh". Left at "Default", Claude Code chooses.

---

## 3. The words used

| Word | What it means here |
|---|---|
| **Agent** | The AI that works for one user |
| **Container** | A closed box on our server where one user's agent runs. Also called a sandbox |
| **Tex** | The lead agent. The one the user texts |
| **The crew** | Tex plus the specialists: Byte (code), Patch (code review), Scout (research) |
| **Engine** | The program that runs the agent inside the container. There are two: Hermes and Claude Code |
| **Hermes** | An open-source agent program. Used with an API key or with Textcrew AI |
| **Claude Code** | Anthropic's agent program. Used when the user connects their own Claude plan |
| **Bridge** | A small program inside each container. It takes a message in and sends the agent's events out |
| **Turn** | One piece of work: a message comes in, the agent works, a reply goes out |
| **Chat** | One place to talk: web chat, or one linked Telegram chat |
| **Conversation** | One stretch of a chat, from one "New chat" to the next. The agent keeps a separate context for each |
| **Credit** | Our unit of payment. 1 credit is $0.01 of price |
| **Job** | A piece of work written into a queue, to be done a moment later |
| **Queue** | A waiting line of jobs |
| **Webhook** | A message that another service sends to our server, for example Telegram telling us a user wrote |
| **api** | The part of the backend that receives requests and webhooks |
| **worker** | The part of the backend that does the jobs |
| **vm-manager** | The service that starts and stops containers |
| **Egress proxy** | The only way out of a container to the internet. It allows only listed addresses |
| **Platform tools** | The tools we give the agent: send a message, run an app action, ask for approval, and so on |
| **Composio** | The outside service through which we reach the user's apps (Gmail, GitHub and others) |
| **Clerk** | The outside service that handles sign-in |
| **Polar** | The outside service that handles payments |
| **LiteLLM** | A program on our server that passes requests to AI models and keeps a budget per user |
| **Caddy** | The program at the front of our server. It handles HTTPS and is the only open door |

---

## 4. The parts

Picture: GoDraw, page 1, "The big picture".

### What we built

| Part | What it is | What it does |
|---|---|---|
| **Backend** | One program run as two processes, the api and the worker | The api receives everything and answers fast. The worker does the work |
| **vm-manager** | A separate small service | Creates, wakes, stops and deletes each user's container |
| **Agent image** | What is inside every container | The two engines, the Bridge, the crew's definitions, and a browser for Scout |
| **Web app** | A website for signed-in users | Sign-up, chat, approvals, apps, automations, the crew, memory, billing, settings |
| **Landing page** | The public website, textcrew.in | Explains the product and collects the waitlist |

### What runs on the server

| Service | What it does |
|---|---|
| Caddy | The only door open to the internet. Handles HTTPS |
| api | Receives requests and webhooks. Also serves the agent's tools |
| worker | Runs the jobs |
| Postgres | The database: users, messages, credits, the activity log. Today a container on the server. Decided on 14 October 2026: it moves to Neon, a managed Postgres in Ohio, together with the vm-manager's and LiteLLM's databases. Each query then takes about 260 ms from the Mumbai server; you chose Ohio knowing that. The move is a script still to be run (`aws-setup.md`, section 8) |
| Redis | The job queues, locks and rate limits |
| vm-manager | Controls the containers |
| LiteLLM | The gateway to AI models for Textcrew AI |
| Egress proxy | The only way out of a container |
| One container per user | Where the agent runs. Started when needed, stopped after 3 idle minutes |

### Outside services

| Service | What we use it for |
|---|---|
| Telegram | The chat channel |
| Clerk | Sign-in |
| Composio | Reaching the user's apps |
| Polar | Payments |
| Anthropic | The user's own Claude plan, used from inside their container |
| A model provider | Textcrew AI. No working key yet |
| Brave | Web search for Scout when the engine has none of its own |
| Vercel | Hosting the web app and the landing page |

---

## 5. How the main things work

### 5.1 Signing up and linking Telegram

1. The user signs up in the web app. Clerk handles the sign-in.
2. Clerk tells our server that a new user exists.
3. The worker creates the account and gives it 100 credits.
4. The worker asks the vm-manager to create the user's container. It is created but not started.
5. In the web app the user asks for a link code. It looks like `LINK-ABCD-EFGH`, works once, and lasts 10 minutes.
6. The user sends that code to our Telegram bot.
7. The worker checks the code and ties that Telegram chat to the account. The bot answers "Linked".

A message from a chat that is not linked gets only one reply: "this chat is not linked". Nothing else happens.

**The first visit.** Right after sign-up the web app shows a few welcome steps, then a "Getting started" checklist on its home page. Whether the user finished or skipped the welcome steps, and whether they closed the checklist, is kept on the account, so it shows once and not again on another device. The users who signed up before 15 October 2026 see it once too. The user can see the welcome steps again from Settings, and an admin can show them again for one user. Details: `backend-report.md`, sections 6 and 31.

### 5.2 One message, from start to end

Picture: GoDraw, page 2, "One message".

Example: the user texts "email Priya the notes".

1. Telegram calls our server with the message.
2. The api checks that the call really comes from Telegram. It saves the message once, adds a job, and answers Telegram at once.
3. The worker takes the job. It locks this user, so that only one turn runs for them at a time.
4. The worker checks the user's credits. At zero, the user gets a short "out of credits" reply and the container is not started.
5. The worker asks the vm-manager to wake the user's container. This takes 2.5 to 3.5 seconds if it was asleep. In web chat it is usually awake already: see "Waking before the message" below.
6. The vm-manager hands the message to the Bridge inside the container. The Bridge gives it to the agent. On the user's Claude plan with the model left on "Default", Tex runs on Sonnet 5.5 at low effort, so a chat answer starts quickly; Byte and Patch keep Opus 5.5 at medium effort for code.
7. The agent works. It may call tools, and Tex may hand parts to the crew. In web chat short progress lines show in plain words ("Checked your inbox"), and the reply shows a few words at a time while the agent writes it. The answer then keeps a one-line trail of its steps, such as "Checked your inbox · 2 steps", that opens to the list. On Telegram the chat shows "typing…" from about a second after the message, until the reply arrives in one piece.
8. The agent gives its final reply. The worker sends it to Telegram as a simple text message: it takes the formatting symbols out first. The saved reply keeps them, so the web app shows it with its formatting.
9. The worker gives the user's lock back, so their next message can start at once. A separate job then counts what was used and charges credits. On the user's own Claude plan that job does not ask the AI gateway at all: the AI is not ours to charge. The time the container was awake still is.
10. After 3 idle minutes the container stops. The user's files stay.

**Waking before the message.** When the user opens the web chat, and when they start typing, the web app asks the server to wake the container, at most once a minute. The server does nothing if the container is already awake, if the user has no credits or no AI connected, or if the account is paused. Otherwise the worker wakes it, as in step 5, so the message does not wait for the wake. The awake time costs credits as usual, and the 3 idle minutes count from the wake. Telegram has no typing signal, so a Telegram message still waits for the wake. Details: `backend-report.md`, section 9.

**Quicker answers on Hermes.** The AI gateway adds Anthropic's prompt cache and a low thinking effort to the agent's calls, on Textcrew AI and on the user's own key, where the model takes them. Details: `backend-report.md`, section 30.

**Why the api and the worker are separate:** Telegram expects an answer within seconds. So the api only saves the message and answers. The slow work happens afterwards in the worker. If the worker crashes, the job is still in the queue and runs again.

### 5.3 The agent does something in an app

1. The user connects an app once, in the web app. They approve access on that app's own screen. We never see their password.
2. Later the agent wants to act, for example send an email.
3. The agent calls our tool for app actions. The api, not the container, calls Composio. So the keys for apps never enter a container. The agent knows the common Gmail actions and their inputs from its instructions. For any other action it lists the app's actions (a name and one line each) and then reads that one action's inputs. What comes back is kept short: a fetch of emails gives who, what, when and a snippet of each, and any answer is cut at about 8,500 tokens, with a note on how to ask for less.
4. If the action is risky, the tool refuses and tells the agent to ask first. Risky means: sending to another person, deleting, or paying.
5. The agent asks, with the action's exact details. The api first checks the details against the app's own list of inputs for that action, so the user only ever approves something that can run. Tex says what it wants to do, in a message made from the request's own summary, with Approve and Deny buttons: "I'd like to send an email to priya@example.com with subject "Notes". Approve or Deny below." The turn ends there. In the web app the "working" sign stops and the chat says "Waiting for your OK".
6. The user's answer arrives as a new message. After Approve the agent runs the action: the details saved with the approval run, exactly as they were approved, and the agent does not send them again. It says how it went. After Deny it says it won't do it. In the web app Tex shows as working again while it does this.
7. An action that changes something costs 1 credit. Reading and searching are free.

An approval works once, and only for the exact action and details the user saw. If the app still refuses it, the agent asks again with corrected details; the earlier request is then marked "replaced", never "denied", because the user did not say no.

**The same question on Telegram too** (16 October). When the user has linked Telegram, a question asked anywhere else (web chat, the Automations chat during an automation's run) is also sent to their Telegram chat, with the same Approve and Deny buttons and a last line saying where it was asked. The first answer wins: deciding is one database step, so a second tap finds it answered. Then every copy on Telegram loses its buttons and says how it ended, for example "✅ Approved on web" or "❌ Denied on Telegram". The question asked in a Telegram chat loses its buttons after a tap too. The agent always goes on in the chat it asked in. On Telegram only a button answers a copy; a plain "yes" there still answers only a question asked in that chat.
**The agent's own actions** (since 16 October) are asked about the same way, with the same card, the same 24 hours and the same "the answer comes as a new turn":

- **Claude Code's commands and file changes.** Textcrew's own "auto mode" decides each one. Reading, searching, work inside the workspace, tests, builds and local git run without asking. A network command while Scout's browser is on (`curl`, `wget` and the like), changing git's remotes, and deleting or overwriting files outside the workspace ask first. The platform's own files and the sign-in files are never allowed. A small program in the container, the gate, makes this check before every command; a gate that fails refuses the command, it never runs it. The card shows the exact command, and after the yes that exact command runs once.
- **Git pushes, on both engines.** A new branch the agent makes, and more commits on it, go through. A push to a branch that already existed, and any force push, need the user's yes; the git gateway asks, so this holds for Hermes too. The default branch and deleting a branch stay refused.
- **Hermes** keeps refusing its own "dangerous command" prompts by itself.

### 5.4 A reminder or an automation

There are three kinds:

| Kind | Example | What starts it |
|---|---|---|
| Once | "Remind me Friday at 10" | A timer |
| Repeating | "Every Monday at 9, list my open pull requests" | A schedule in the user's time zone |
| App event | "When my boss emails me, tell me" | Composio tells us the event happened |

When one fires, it goes down the same path as a normal message, with the saved instruction. So it wakes the container and costs credits like a message does.

- **Where it answers: the Automations chat.** Every run of every automation answers in one conversation of its own, the user's Automations chat, wherever the automation was made. That covers timers, app events, pull-request review verdicts, and the notices (out of credits, paused after three failures). It is never made the active conversation, so it never mixes into the user's own chats. The web app pins it at the top of the chat list, with a mark when a new run arrived. The user can write there to follow up: the agent keeps a context of its own for it, with the runs in mind. The user cannot delete it: it goes only with the account.
- **A copy on Telegram.** An automation made in a Telegram chat also sends a copy of each answer there, as plain text: the automation's name on the first line, and on the last line that the follow-up happens in the Automations chat. The copy is shown in the Telegram conversation but is not part of its context. Each answer is copied once, also when a job runs again. An automation made in the web app sends the same copy to the user's linked Telegram chat only when the user switched on "Automation runs finish" (below, "Telling the user on Telegram"); it is off at first.
- **A late run.** A run that was due while the server was off runs when it is back, never skipped. If it starts more than 10 minutes late, the agent says so and says when it was due.
- **The user's time zone.** Every account starts on UTC. The web app sets the browser's time zone once, while nobody has set one, and never replaces one the user chose.

An automation pauses itself at zero credits, or after three failures in a row. The shortest allowed interval is 15 minutes.

**How one is made: a draft first** (your decision of 16 October).

1. The user asks Tex, in web chat or on Telegram: "Every Monday at 9, send me my open pull requests."
2. Tex calls `propose_automation` with the parts of the automation and the apps it will use. The platform checks it as a save would: the plan's limit, 15 minutes between runs, a real time zone, a moment not past, the apps connected. A problem goes back to Tex to fix.
3. The platform saves a draft and posts it in the chat. Nothing runs: no timer, no watch at Composio. Tex's turn ends there.
4. **Web chat** shows a card with the five steps drawn small, "Not saved yet", **Open in Automations** and **Save**. **Telegram** gets the same as an outline in plain text, the link and a **Save** button.
5. The link, `/automations/new?draft=drf_…`, opens the draft on the canvas (below), with Save, Save paused and Discard.
6. When the user saves, the automation is made, with its timer or its watch. The card then says "Saved" with a way to open it.

The rules:

- **A plain one-time reminder** ("remind me Friday at 10 to call the bank") still goes straight through, as before.
- **Only the user saves.** Tex has no tool that saves, and the tool that made automations straight away (`create_automation`) is no longer Tex's.
- **One save, one automation,** even on a double click. The plan's limit is checked again at Save. A draft does not count against the plan, and proposing costs nothing.
- **A draft lasts 7 days.** Then its card says "This draft expired. Ask Tex again." A user has at most 20 open drafts. Drafts are removed after 30 days.
- **Asked again.** When the user asks Tex to change a draft, Tex proposes again and the old draft becomes "replaced", as an approval asked again does; its card says so. When the user asks to change a saved automation, Tex proposes the change: its link (`/automations/aut_…?draft=drf_…`) marks the boxes that change, and Save makes the new automation and then removes the old one.
- **During an automation's run, Tex cannot set a reminder.** An email or a page read during a run could otherwise ask for one, and a reminder is saved without the user seeing it first. A draft is still possible: the user sees it and decides.

**On a canvas.** Each automation has a page of its own in the web app, `/automations/aut_…`, opened from its card. It shows the automation as five boxes joined by arrows, left to right:

| Box | What it shows | Example |
|---|---|---|
| Trigger | When it runs, and whether it is on or paused | "Every Monday at 9:00 AM, your time" |
| Tex's instruction | The title and the instruction | "List my open pull requests in acme/web" |
| Apps Tex may use | The trigger's app; for older automations, "Your connected apps, as needed" | GitHub |
| Asks you first | The platform's fixed rule | "Sending, deleting or paying waits for your OK" |
| Results | The Automations chat, and the chat app a copy goes to | "Automations chat", "Copy to Telegram" |

- A draft opens on the same canvas, marked "Not saved yet", with Save, Save paused and Discard. "Save paused" makes the automation switched off, to turn on later.
- The apps named in a draft or on the canvas are kept with the automation and drawn in the Apps box. They are a limit (below).
- The drawing library is React Flow (MIT licence, version 12.12.0, about 59 KB). It loads on that page only. Its small "React Flow" link in the corner stays, as you decided.
- **Phones** (under 768 pixels wide) get the same five boxes as a list of cards. A "List view" switch shows the list on a wide screen too.
- **The cards** on the Automations page each have the same five steps as a small strip of plain text, without the library.
- For the picture the API now says two things it kept to itself: where the copy of each answer goes (`copyTo`: Telegram, or none), and the trigger's settings (for example the repository a pull-request review watches). `GET /v1/automations/{id}` reads one automation.

**Building and changing one by hand** (phase 3, option A; built on 16 October). The same five boxes can be edited. A click on a box opens its settings in a side panel:

| Box | What the user sets |
|---|---|
| Trigger | Once (a date and a time); a schedule (every day, some weekdays, every N hours, or a cron line for experts), always in a time zone, the user's own to start with; or an app event, picked from the list of events that app offers, with its settings |
| Tex's instruction | The title and the instruction, in words |
| Apps Tex may use | Some of the user's connected apps, or none named (then any connected app, as before) |
| Asks you first | Before sending, deleting or paying (always), or stricter: before anything that changes something |
| Results | The Automations chat, and a copy to the user's linked Telegram chat or not |

- **"New automation"** opens an empty canvas, or one filled from a template.
- **Checked while typing.** The web app asks the server to check the parts without saving (`POST /v1/automations/check`). The answer has each problem with the box it belongs to, and the next three run times. A box with a problem turns red with the message. The checks are the same as a save's: the plan's limit, a real time zone, a moment not past, at most every 15 minutes, the apps connected and on the plan, an event the app really has with its required settings filled, a linked Telegram chat for the copy.
- **Save, Save paused.** A new automation is made by `POST /v1/automations`, with a one-time key (`clientRequestId`): a double click makes one. A change is saved by `PUT /v1/automations/{id}`, which keeps the automation's id and page; a draft Tex proposed for a change does the same now. A changed app event gets its new watch at Composio first, then the automation points at it, then the old watch is removed, so exactly one watch is left and none is missing on the way.
- **Run once now.** On a saved automation, on or paused: a normal run, at a normal run's cost and with approvals as usual. A line in the Automations chat says it is a test run, and Tex is told too. It does not move the schedule, does not finish a one-time reminder and does not count as a failure. At most 10 an hour per user. To try one before it goes live: Save paused, then Run once now.
- **Ask Tex to change this.** The user's version on the canvas is kept as a draft of their own (`madeBy: user`), and the chat opens with "Change this draft …". Tex reads it with `get_automation_draft` and proposes the change, which replaces the user's draft.
- **The apps are a limit.** While an automation runs, Tex may use only the apps in its Apps box, and the trigger's app. An action in another app is refused, and so is an approval asked for one. With none named (older automations), any connected app works, as before. The worker notes the automation beside the turn in Redis, as it notes the kind of turn; if the note can't be read, the action is refused.
- **"Ask you first", stricter.** Set to "anything that changes something", every app action of that run that changes something needs the user's yes, not only the risky ones. Looser than the platform's rule is never possible.
- **Plan limits stay.** The number of automations, the apps a plan may use and the Max-only features are checked as everywhere else.
- **Phones** get a form with the same five parts in place of the canvas.

### 5.5 A pull request gets reviewed

1. The user turns review on for one GitHub repo, in the web app.
2. Someone opens a pull request there, or pushes new commits to one.
3. Composio tells our server.
4. The worker wakes the user's container and tells Tex to have Patch review that pull request.
5. Patch reads the changes and posts one review with its comments on the pull request.
6. The user gets a short verdict in the Automations chat, with a copy on Telegram when it is linked and the user's "Pull-request reviews finish" switch is on (it is at first).

Each commit is reviewed once. Patch never merges and never approves. Turning review on is the user's standing permission for these comments, on that repo only.

### 5.6 A job for Patch or Byte

1. The user says the brief in chat: the repo, the pull request or branch, their own instructions, what to look for (Patch) or what to fix and what to test for (Byte), the commands to run, and what to do with the report. Tex gives it to the platform as a job. (Until 16 October the web app also had a form for it, on a Crew screen. The form is gone; the API behind it, with the list of the user's GitHub repos, is still there.)
2. The api saves the job and queues it like a message. It runs as soon as the user's agent is free, as one turn.
3. Tex hands it to Patch or Byte. They clone into a folder of the job's own, and may start what the job needs there (an install, the app, the tests). A large review may be split into up to three Patch reviews at the same time.
4. The report comes back in a fixed shape: the verdict, the findings or changes with file and line, the tests run with their results, and what was not checked. It goes to the chat it was asked in, and the platform keeps it on the job. If the brief asked for it, it is also posted on the pull request as one review comment (Patch), put in the pull request Byte opens, or opened as an issue.
5. After the turn, the container itself stops every program of the job and deletes its folder. Then the container goes to sleep at once, unless something else is running there.

When the job was asked in the web app and Telegram is linked, a short notice goes to Telegram as well, in addition to the report in the chat: "✅ Byte finished: Fix the login redirect in acme/web. Done. Pull request: … Tests passed. Report: <link to the conversation>", or "❌ Patch couldn't finish: … <why>". A job asked on Telegram has its report there already, so it gets no extra notice.

**Telling the user on Telegram** (16 October). Settings → General has "Tell me on Telegram when…", shown once Telegram is linked, with three switches: Byte or Patch finishes a job (on at first), pull-request reviews finish (on), and automation runs finish (off; it is about automations made in the web app, since those made on Telegram always answer there). A notice on Telegram is always in addition to the chat the work was asked in, never instead of it. Nothing is sent when Telegram is not linked, is switched off, or blocked the bot. Each notice is sent once, also when a job runs again.

**Quiet hours.** Also in that group: quiet hours, 22:00 to 08:00 in the user's time zone at first, which the user can change or switch off. During quiet hours every Telegram message still arrives at once, but silently: the phone makes no sound. Nothing is held back.
The brief is the user's yes for the job's own branch and its pull request, and for nothing else. Nothing is asked during the job: anything else that needs an OK (a push to another branch that already existed, a network command, a change outside the workspace) is refused and listed in the report. After the job the user is asked whether to run it again with exactly those allowed, with an Approve button; after the yes the job runs again, and each listed item goes through once.

From chat, posting the review on the pull request needs an ordinary approval first. (A brief sent by an app through the API carries its own tick for that, which is the user's yes for that one review, on that pull request, for that job only. No app sends one now.)

### 5.7 Research and the browser

- Only Scout touches the web. Scout has no files, no shell and no app tools, so a web page cannot trick it into sending or deleting anything.
- If the user's engine has its own web search, Scout uses that. This is the case on Claude Code. It costs no credits.
- Otherwise Scout uses our search, which runs on Brave. That is part of the Max plan and costs 1 credit per search.
- Scout can read a web page through our page reader. That is free on every plan.
- On the Max plan Scout can drive a real browser, for pages that need clicking or JavaScript. The browser runs inside the user's own container and costs 2 credits per minute.

### 5.8 The container sleeps and wakes

Picture: GoDraw, page 3, "The life of a container".

- A container is stopped most of the time. A stopped container costs nothing.
- A message, a reminder or an app event wakes it.
- While a turn runs, the container is never stopped.
- After 3 idle minutes it stops again. Its files are kept. After a crew job it stops right away, when nothing else runs there.
- The server allows only a set number of containers awake at once. When it is full and another user needs one, the container that has been idle longest is stopped early.
- A container is deleted only when the user deletes their account.

---

## 6. AI, three ways

| Way | Who pays for the AI | Engine | State |
|---|---|---|---|
| **The user's Claude plan** | The user, to Anthropic | Claude Code | Works on the test server |
| **The user's own API key** | The user, to the model provider | Hermes | Built, never run for real: no key with balance to test it |
| **Textcrew AI** | The user, to us, in credits | Hermes | Built, never run for real: no working model key |

With the first two, the AI part costs no credits. Awake time and app actions still do.

How the user's own key is used:

1. The user saves the key in the web app. We check it with the provider and store it encrypted.
2. LiteLLM, the AI gateway on our server, gets a copy that only this user's agent can use.
3. Every model call from the user's agent now goes to their provider, with their key. The key never enters the container.
4. If the user deletes the key, chooses Textcrew AI, or connects a Claude plan, the agent stops using the key and LiteLLM's copy is deleted.

Example: Asha saves an OpenAI key and names no model. Her agent now runs on `gpt-6.1-sol`, billed by OpenAI to her. She pays us credits only for awake time and app actions.

So today only the Claude plan has worked from start to end. A server setting can turn Textcrew AI off; then a user who has not connected their own AI is told to connect it first. This is the proposed setting for the beta, because there is no working model key. It is your choice.

---

## 7. Plans and credits

Picture: GoDraw, page 4, "Credits".

### The plans

| | Free | Pro | Max |
|---|---|---|---|
| Price | $0 | $12 a month | $30 a month |
| Credits | 100, once, at sign-up | 1,500 every month | 4,500 every month |
| Apps | 10 | 25 | 25, plus your own tool servers |
| Automations | 1 | 5 | 50 |
| Top-ups ($10 for 800 credits) | No | Yes | Yes |
| Scout's browser | No | No | Yes |
| Web search through Textcrew | No | No | Yes |
| When the server is busy | Normal | Normal | First in line |

### What costs credits

| Thing | Price |
|---|---|
| Textcrew AI | Its real cost times 2.5 |
| The container being awake | 1 credit per 10 minutes |
| An app action that changes something | 1 credit |
| Scout's browser | 2 credits per minute |
| A web search through Textcrew | 1 credit |

Free: reading and searching in apps, reading a web page, and the web search built into the user's own engine.

### The rules for credits

- 1 credit is $0.01 of price.
- Credits arrive in batches. Each batch lasts 90 days.
- The batch that ends soonest is spent first.
- We never store one "balance" number. The balance is worked out each time from the batches and the list of charges.
- Every charge is written once, even if a job runs twice.
- At zero credits a turn does not start, and automations pause.

### Cancelling, and keeping the plan after all

- Cancel stops the plan at the end of the month already paid for. Until then the plan stays.
- Until that day, "Keep my plan" undoes the cancel. Polar is asked to renew the plan again. Nothing is charged at that moment, and no credits are given. The next renewal charges and gives credits as usual.
- Paying for the same plan again while it still runs is refused, so nobody pays for a second month beside the first.

### Auto top-up (switched off on the server for now)

Polar can charge a saved card without the user being there, for a one-time product such as the top-up. It calls these "off-session charges". They are in preview, need a paid Polar plan, and Polar must switch them on for our account. So auto top-up is built but hidden, behind the server setting `AUTO_TOPUP_ENABLED` (off by default).

When it is on:

- Only Pro and Max users can use it. They switch it on in Pricing, pick when (under 100 credits, say), the pack ($10 for 800 credits), and the most per month (2, say), and tick a box that allows the charges. It uses the card Polar already has for their plan.
- After a charge leaves the balance under their line, the worker tries one top-up. It does nothing if the month's limit is reached, if the last try was less than an hour ago (a day after a declined card), or if a top-up is already paid and its credits are on the way.
- The credits come only from Polar's "order paid" event, as for a top-up bought by hand.
- After 2 declined cards in a row it turns itself off, and the user is told in the web chat and on Telegram. With no saved card, or when Polar refuses for another reason, it turns off at once and says so.
- With the setting on, Pricing and Help no longer say that nothing is ever charged at zero.

**Still open:** you want Free users to run out sooner, so that they buy a plan. The choices are fewer sign-up credits, a shorter life for them, or higher prices for everyone. Nothing is changed yet.

---

## 8. The safety rules

These rules hold everywhere in the system.

1. **Only Caddy is open to the internet.** Everything else is on private networks.
2. **A webhook is checked before anything else.** If the signature is wrong, nothing happens.
3. **A webhook never does the work.** It saves the event once, adds a job and answers.
4. **Every job can run twice without harm.** Each one first checks whether it was already done.
5. **Only the vm-manager touches Docker.** The backend asks it; it never reaches a container itself.
6. **A container has no internet.** Its only way out is the egress proxy, with a list per user.
7. **The agent cannot pretend to be another user.** We know the user from the container's own token, never from what the agent says.
8. **No platform keys go into a container.** Not for apps, not for models, not for the database.
9. **Risky actions need the user's yes.** Sending to others, deleting, paying. Also the agent's own risky actions: on Claude Code, network commands while the browser is on, changing git's remotes and changes outside the workspace; on both engines, a push to a branch that already existed or a force push.
10. **Secrets are encrypted in the database.** Tokens and codes are stored only as fingerprints that cannot be turned back.
11. **Everything the agent does is written to the activity log.**
12. **Only the user makes an automation that repeats or watches an app.** Tex proposes it as a draft; the user saves it, or builds it by hand. During an automation's run Tex cannot set a reminder either, and may use only the apps the automation names.

One exception to rule 6, by decision: a Max user's container with Scout's browser turned on can reach any public website. Addresses inside our own network stay refused.

---

## 9. Decisions made

| Topic | Decision |
|---|---|
| Audience | Developers and tech founders who manage a team. First use case: pull-request review |
| Channels | Telegram and the web app. WhatsApp and iMessage are built and switched off |
| AI | Three ways: own API key, own Claude plan (labelled beta), Textcrew AI on credits |
| Plans | Free $0, Pro $12, Max $30, top-up $10 for 800 credits. Credits last 90 days |
| The crew | Tex, Byte, Patch, Scout |
| Web search | Only Scout searches. The engine's own search first; Brave on Max otherwise |
| The browser | Max plan. It runs inside the user's own container, not at an outside provider |
| Memory | One memory on the platform, shared by both engines |
| Payments | Polar, on the website only. The Telegram bot never sends a purchase link |
| Web app hosting | Vercel |
| Server for the beta | The AWS test server. The VPS comes after the beta is tested |
| Containers | Every message, reminder and automation goes through the user's container |
| Automations | Anything more than a plain one-time reminder goes through a draft the user saves, on web and Telegram. Each automation is drawn as a flow (React Flow); phones get a list. Building by hand: option A (today's shape on the canvas), then C (a few steps in one run). Decided on 16 October |

---

## 10. Rules from other companies

Other companies' rules decide part of what we can launch. These were read on 2 October 2026. Rules change, so check them again before a public launch.

| Company | The rule | What it means for us |
|---|---|---|
| **Meta (WhatsApp)** | AI assistants are not allowed on WhatsApp's business platform outside Europe | Not a launch channel. The code stays switched off |
| **Telegram** | AI bots are allowed. Digital goods sold inside Telegram must be paid with Telegram Stars | Our launch channel. The bot never sends a purchase link. Plans are bought on the website |
| **Apple (iMessage)** | No safe route for a bot with no human behind it | Not at launch. Maybe later, clearly labelled as a beta |
| **Anthropic (Claude plans)** | Running Claude Code for users is allowed with conditions: the program is not modified, each user signs in with their own plan, and we never pay for or resell their usage | Offered as a beta. Two things to do: accept Anthropic's Commercial Terms, and ask them in writing whether our setup is within the rule |
| **Google (Gmail)** | An app that reads Gmail must be verified by Google, with a yearly security review by an outside firm. Until then it shows an "unverified app" warning and stops at 100 new users | The beta uses Composio's shared Google app, so Google's "Allow" screen names Composio. Our own Google app shows "Textcrew", but its verification must start well before we grow (`composio.md`, section 9) |
| **Polar** | Sellers in India are supported. AI tools get a closer review | Expect a review when the account is created |
| **India** | The data protection law asks for a clear consent notice and a way to handle access and deletion requests. Sales to Indian users carry 18% GST | The privacy page and the prices must cover this |

Two grey areas with Anthropic's rule are known. The one-time sign-in code passes through our server on its way to Claude Code. And Claude Code keeps the user's sign-in in their container, which is on our server. Anthropic's answer in writing would settle both.

---

## 11. Not in the MVP

- WhatsApp, iMessage and SMS. The code exists and is switched off.
- Apps in the Play Store or App Store. Phone users use Telegram and the web app.
- A model we host ourselves.
- Searching the user's documents.
- Phone calls.
- Signing in to websites inside Scout's browser.
- More specialists than Byte, Patch and Scout.

---

## 12. Where it stands

### Works for real on the test server

- A Telegram message to the agent and back, on a Claude plan.
- Linking Telegram with a code.
- Gmail and GitHub through Composio, with approvals.
- Tex handing research to Scout, and Scout searching the web.
- Scout's browser: opening pages, clicking, reading. Browser time is charged.
- Containers stopping after idle time and waking again.
- The agent's tool paths being closed from the internet.
- A real sign-up through Clerk in the web app at `https://app.textcrew.in`: the account, the 100 sign-up credits and the container were made. This was on Clerk's development setup, before the move of 15 October (below).
- Connecting a Claude plan in the web app, and a web chat message answered by the agent.
- Tested on 8 October (on a test account): a reminder that fires, a daily automation created and cancelled, the 15-minute limit, a free GitHub read, an approval approved (an email sent) and one rejected, memory saved, recalled and forgotten without naming the tool, a password refused as a memory, Scout reading pages on Claude Code, the browser, out of credits, "connect your own AI first" for a user with none, the idle stop (3 minutes 11 seconds), and the isolation test (5 of 5).
- A request Anthropic refuses gets a clear reply, is not counted as our fault and is not kept in the chat's history.
- A new chat from the web app's code path, and Claude Code running with the model and effort chosen in Settings (Opus 5.5 at "xhigh" was checked on the running process).
- Each conversation keeping its own context, tested on 9 October with the test script on a test account. A code word was said in one conversation. A new chat answered "unknown" when asked for it. Going back to the first conversation gave the code word. The new one still answered "unknown" afterwards.
- The old messages were sorted into conversations when the server was updated: both accounts show their earlier chats in the list.
- The app list says which apps can be connected: on this server Gmail and GitHub, and "not yet" for the other 23.
- A reply written for the web app: asked on 9 October for a comparison and a command, the agent answered in web chat with a Markdown table and a code block. The same stored reply, passed through the plain-text step on the server, came out with no table pipes, stars or backticks.

### Built, never run for real

- Sign-in on Clerk's production setup (15 October). Clerk is the outside service that handles sign-in. Until then it ran on Clerk's development setup, which is meant for building and has test keys. Now it runs on the production setup for `textcrew.in`, with live keys: Clerk answers at `clerk.textcrew.in`, and Google's sign-in screen names Textcrew, through Textcrew's own Google sign-in app. The live web app loads the live key and the api restarted healthy, but nobody has signed up on it yet. Accounts from the development setup do not carry over, so everyone signs up again.
- The databases on Neon (14 October). The backend, the vm-manager and LiteLLM were each run against scratch Neon databases from the laptop, and the move script copied a local database into Neon with matching row counts. The server still uses its own `postgres` until the move script is run there.
- Textcrew AI on the Hermes engine. There is no working model key.
- The user's own API key. Every model call goes to the user's provider with their key, through LiteLLM on our server. There is no key with balance to test it.
- Payments through Polar.
- Pull-request review, and Byte pushing code through our git gateway.
- Crew jobs: a brief for Patch or Byte from chat (the web app's Crew screen and its form were removed on 16 October; the crew is explained in the web app's Help, and Tex sends every change to a repository to Byte and every pull-request review to Patch), the report in its fixed shape, the list of GitHub repos to pick from, the container stopping every program of the job and deleting its folder, and the container sleeping right after. Built on 13 October. Checked with the automated tests (the clean-up with real programs on Linux, not inside gVisor) and the web app's demo mode. Nothing has run against real GitHub, Composio or a container.
- A memory saved on one engine and used on the other.
- The chat history in the web app with a signed-in user: the list beside the chat, rename and delete. The screens were checked in the web app's demo mode and the backend with the test script, but nobody has clicked through them on the live site yet.
- A reply on Telegram since replies there became plain text. The agent's instructions and the plain-text step are both on the server, but no real Telegram message has been sent through them yet.
- The web app drawing a real reply as Markdown for a signed-in user. It was checked in the web app's demo mode only.
- The reply showing a few words at a time in web chat. Tested with stand-ins, in the web app's demo mode, and with a real Claude Code program talking to a fake AI service. Not yet with a real model, with Hermes, or on the server.
- A conversation older than 30 days being opened again. Claude Code removes its own saved sessions after 30 days, so such a conversation would start with no context. Your decision (below).
- The desktop app. It is now a small window around the live web app (`https://app.textcrew.in`), so it always shows the same screens. It reaches the sign-in page, and Clerk's and Google's sign-in pages open inside the window. Nobody has signed in with a real account in it, and the tray icon, the shortcut and "start at login" have not been run. A Linux installer builds; Windows and Mac installers are not built.
- Web search through Brave. The key works; the path through the app has not run.
- Textcrew's own connect screen in the web app, and the page after a sign-in that says "connected" or "didn't connect". Checked in the web app's demo mode only.
- Connecting straight to the provider's page with our own sign-in app (no Composio page), and `/oauth/callback`, the way back through our own address. No own sign-in app is registered yet. The way back answers on the server (checked on 15 October).
- For our own Google sign-in app, built on 15 October on the branch `feat/composio-own-google-app` (not on `main` yet), with the automated tests only:
  - **a trial switch:** two settings give a second setup per app to a few named users only, while Google reviews our app;
  - **a scope check:** the ops script's `scopes` command prints what an app's sign-in asks for, and each scope's class at Google. It only reads;
  - **one connection per account:** Tex uses the newest connection of an app. Connecting the same account again moves its automations to the new connection and removes the old one. A second account of the same app is kept.
- The server setting up an app at Composio by itself on the first connect (`COMPOSIO_MANAGED_APPS`). Not switched on on the server.
- A late run saying so, and the web app setting a new account's time zone from the browser. Built on 13 October after the founder's "every morning at 9" summary landed in an unrelated chat at 3:01 PM India time. Checked with the automated tests, and the web app's part in its demo mode.
- Deleting an account now also removes the user's approvals and activity log (15 October), as the privacy page says. Only an admin's record that they deleted the account stays. A connected app that Composio could not remove is tried again. Checked with the automated tests; no account has been deleted on the server since.
- The privacy page's promises made true (16 October, on the branch `fix/privacy-retention` in the backend, the vm-manager, the landing page and the web app, not on `main` yet). You left the choice to Claude: the backend was fixed where it fell short, and the page now says what is true. Deleting an account deletes the archives of the user's files at once, and the vm-manager deletes every archive after 7 days (`SNAPSHOT_KEEP_DAYS`, equal to `BACKUP_KEEP_DAYS`); raw events go after 30 days whatever their state; a deleted account's `users` row keeps no email, name or time zone. The privacy page, the home page, the web app's Delete account and its Help say backups are kept 7 days. The web app no longer marks your own API key "Recommended". Checked with the automated tests only; `backend-report.md` sections 33 and 37.
- Faster app actions, such as "check my email" (16 October, on the branch `perf/app-action-speed` in the backend, the vm-manager and the web app, not on `main` yet). On 15 October that question took 62 seconds and 13 rounds of the model: the list of Gmail's actions alone was about 33 thousand tokens. Now the list has no inputs (one action's inputs come from a new tool), an email fetch sends a short summary of each email, the agent knows the common Gmail actions and answers once after its last tool, its steps show in plain words, and the web app shows a sent message at once. Sending from web chat waits for 3 trips to the database instead of 7, and an app tool call for 1 instead of 4. Checked with the automated tests only; not yet timed with a real model.
- Approvals that hold exactly what runs (15 October, on the branch `fix/approval-args`, not on `main` yet). The founder's test email of that evening was never sent: Tex asked with an input Gmail doesn't have (`to` instead of `recipient_email`), the approved run failed, and Tex asked a second time. Now such a request is refused before the user sees it, the approved details run as saved, and a request asked again shows as "replaced" in the web app. Checked with the automated tests only.
- Unread conversations (16 October, on the branch `feat/unread-dot` in the backend and the web app, not on `main` yet): a blue dot in the web app's chat list on a conversation with a message from the agent that the user has not seen, on web and Telegram conversations and the Automations chat. Opening the conversation marks it read. Checked with the automated tests and the web app's demo mode. It needs the database update (migration 0025) when it goes to the server, and the web app works with the backend before and after.
- The Automations chat: every run, verdict and automation notice answering there, pinned in the web app's chat list with a mark for a new run, and a copy of each answer on Telegram for an automation made there. Built on 13 October, after your decision for a separate automation chat. Checked with the automated tests, and the web app's part in its demo mode in a browser. No real run has gone through it yet. The conversations that automations made for themselves earlier that day stay as ordinary chats.
- Automations on a canvas, phase 1 (16 October, on the branch `feat/automations-canvas` in the backend and the web app, not on `main` yet): each automation's own page draws it as five boxes (section 5.4), read-only, with a list on phones, and each card on the Automations page has the same steps as a small strip. The API now says where the copy of each answer goes and the trigger's settings, and reads one automation. Checked with the automated tests and the web app's demo mode. No database change.
- Automations from the chat as drafts, phase 2 (16 October, on the same branch, and in the vm-manager for the Bridge's instructions): Tex proposes anything more than a plain reminder with `propose_automation`; the platform checks it and saves a draft that never runs; web chat shows it as a card with a small diagram and Save, Telegram as an outline with the link and a Save button; the link opens it on the canvas with Save, Save paused and Discard. A draft lasts 7 days, at most 20 are open, and asking again replaces the old one. `create_automation` is no longer Tex's, and `schedule_reminder` is refused during an automation's run. Checked with the automated tests, the web app's demo mode, and end to end on the laptop with the real backend and the web app (stand-ins only for Tex, Composio and Telegram); not yet tried on the server with a real Tex and Telegram. It needs the database update (migration 0026) and the new agent image when it goes to the server.
- Notices and approvals on Telegram (16 October, on `main`): "Tell me on Telegram when…" in Settings → General with three switches and quiet hours, a short notice when a crew job from the web app finishes, the copy of a web-made automation's answer when switched on, every approval asked on Telegram too with the buttons taken away once answered anywhere, and silent messages at night (sections 5.3 and 5.6). Checked with the automated tests and the web app's build; no real Telegram message has gone through it yet. It needs the database update (migration 0027) when it goes to the server.
- Automations built and changed by hand, phase 3 (16 October, on `main`): the canvas edits the five boxes; the server checks the parts while the user types, with each problem on its box and the next three runs; Save once per key, Save paused, a change in place that keeps the automation's page (a changed app event gets its new watch before the old one goes), Run once now as a marked test run (10 an hour), Composio's list of events for the picker, "Ask Tex to change this" through the user's own draft, and each run held to its automation's apps and its "ask me first". Checked with the automated tests and end to end on the laptop with the real backend and the web app (stand-ins for Tex, Composio and Telegram); not yet tried on the server. It needs the database update (migration 0027) when it goes to the server; the agent image does not change.

- Approvals for the agent's own actions (16 October, on `main`): Textcrew's rule list for Claude Code, its gate in the container (it fails closed: Claude Code's commands and file changes are no longer allowed without it), the git gateway asking before a push to a branch that already existed or a force push (it reads the push to tell the two apart), the crew job's brief as the yes for its own branch only, with "run the job again" after the job, and the card showing the command or the branch. Checked with the automated tests and with the real Claude Code program on the laptop against a stand-in api (a command allowed, one asked about, one refused; a file written inside the workspace, one outside asked about). Not yet run on the server. It needs the database update (migration 0027) and the new agent image when it goes there.

### Not finished

- Gaps of this kind are listed in `backend-report.md`, section 43.
- **A chat that got a refusal before 8 October stayed stuck** (every new message in it was refused). Starting a new chat fixes it: tested on the test account on 8 October.
- **A failed turn leaves a copy of the chat's session on the user's disk.** Small, but it adds up over time.

### Found on the browser's first test (5 October), and what was done on 8 October

1. **Hermes downloaded its own tools in a container that has the browser.** Fixed by Hermes's own settings: no tool downloads, no calls home at start. Tools already downloaded stay in that user's folder.
2. **"Remember this" went to Claude Code's own memory, not ours.** Fixed: Tex's instructions say to use the platform's memory, and both engines' own memory is switched off.
3. **The browser contacts Google when it starts.** Not fixed: no browser switch stops it. Your decision (below).
4. **Once, a container stayed awake about 6 minutes after a browser turn** when 4 is the most expected. Cause not found. On 8 October the idle stop came after 3 minutes 49 seconds.

### Decisions waiting on you

- **The browser's Google contacts:** (a) use Playwright's smaller "headless shell" browser, which makes none of them, (b) block the two Google hosts in the browser's proxy rule, or (c) accept them.
- **More apps than Gmail and GitHub:** every other app shows "Not available yet" in the web app, because the server has no Composio setup for it. One setting now switches them on: `COMPOSIO_MANAGED_APPS=all` (or a list, such as `googlecalendar,notion,slack`), then a restart. The server makes each app's setup at Composio on its first connect. These apps use Composio's shared sign-in, so the provider's "Allow" screen names Composio. `composio.md`, section 8.
- **Old conversations:** keep Claude Code's 30-day clean-up of saved sessions (an older conversation then starts afresh when opened), or keep sessions for as long as the conversation exists (more disk per user).
- **Codex and other engines:** see `engines-proposal.md`, section 10. A ChatGPT plan cannot be used yet; OpenAI must approve first.

### Smaller open questions

- **Textcrew AI:** which models to offer, and whether 2.5 times cost is the right price.
- **Memory:** may the agent save a memory in a turn the user did not start, such as an incoming email? May the user add or edit memories in the web app?
- **The page reader on Claude Code:** keep it open to any public address, or go back to the strict rule (see `backend-report.md`, section 43).
- **The page reader on Hermes:** it refuses a redirect to an address it has not seen, even on the same site. Keep that, or allow redirects inside one site?
- **Signing in to websites in Scout's browser:** wanted as the next step. Open: how long a sign-in is kept, which sites, and what Scout may do there without asking.
- **Answering a run's copy on Telegram:** the copy says to follow up in the Automations chat. A user who answers on Telegram instead reaches an agent without the run in mind. Leave it, or later let such an answer go to the Automations chat?
- **The waitlist form** still asks about WhatsApp and iMessage. Keep it as a signal of demand, or change it.
- **Composio and the GitHub token:** the git gateway and pull-request review need the user's GitHub token from Composio. The plan was to switch off the project setting "mask connected account secrets". Composio's change note of 22 April 2026 says the token is always hidden for its shared sign-in, whatever that setting says. So Byte pushing code, and Patch reading the code for a review, may need our own GitHub app registered at Composio. Not confirmed: neither has run for real. `composio.md`, section 11, has the details.
- **Pull-request review** needs admin access to the repo, because Composio puts a webhook on it.
- **Disconnecting an app does not try again when Composio fails to remove it** (`backend-report.md`, section 14). Our row is deleted and the app's sign-in can stay at Composio. Account deletion does try again. The rest of the privacy page question of 15 October is settled (built list above).
- **Small gaps the web app found in the API:** no history of past automatic reviews (a crew job keeps its report), no way to add or edit a memory, and progress lines are not shown again after a page reload. The list of repos to pick from exists, for crew jobs, but the web app no longer shows it.
- **Crew jobs without a screen (since 16 October):** the web app has no list of crew jobs now. A job asked for in chat shows only as Tex saying it is queued, Patch's or Byte's lines while it works (web chat only), and the report in the chat. There is no way to see a job's state later, to cancel one that waits (only support can), or to pick the repo from a list: the user names it. Bring back a small list of jobs somewhere, or leave it to the chat?

### Also waiting on you

- **Publishing the corrected privacy page** (16 October). Merge the landing page's branch `fix/privacy-retention` (only the privacy page, its Google section and the 7-day wording; the terms page stays on its own branch until its placeholders are filled), and deploy the backend and the vm-manager of the same branch so the page is true on the server. Two copies on the server are not covered by the 7 days, if they are there: the folder `backups/neon-move-<time>/` made by the move to Neon, and the old local `postgres` volume the move kept. Delete both once you trust Neon.
- After the move to Clerk's production setup (15 October): sign up once in the web app, then make your new account an admin again (in Clerk's dashboard, the role "admin" in the user's public metadata). Your Max plan, extra credits and Telegram link stay on the old account; an admin moves them by hand, and unlinks Telegram on the old account first.
- **Textcrew, not Composio, on Google's screen when a user connects a Google app** (decided on 15 October). Google Calendar goes first, on our own Google sign-in app: its scope is "sensitive", so Google's review is free and takes about 2 weeks. Gmail, Drive, Docs and Sheets stay on Composio's shared sign-in during the beta. They move later, together, because Gmail and Drive are "restricted": 6 weeks or more, and a yearly security check by an outside lab (CASA), about US$675–855 a year. What you do by hand, in order:
  1. Our logo and name on Composio's connect page (5 minutes), and our own GitHub sign-in app (about 20 minutes).
  2. Google's "Limited Use" statement on the privacy page, and a terms page (`/terms` answers "not found" today). The statement is ready on the landing page's branch `fix/privacy-retention`; the terms page waits on its own branch for your placeholders.
  3. Once the brand check below has passed: switch on the Google Calendar API, add its scope, make a second Google sign-in app whose way back is `https://api.textcrew.in/oauth/callback`, make its setup in Composio, and try it on yourself with the trial switch. Claude runs the scope check first and puts the two settings on the server.
  4. Record the demo video and send the app to Google for review.
  5. After Google's approval, switch Google Calendar for everyone, and tell users who connected it before to connect it again.

  `composio.md`, section 9, has every click.
- Google's brand check for the sign-in app: the logo is uploaded (15 October) and textcrew.in is proven ours in Google Search Console. From 16 October (Google asks for a 24-hour wait), in Google Cloud → Textcrew → Branding → View issues, choose "I have fixed the issues" and press Proceed. The check takes a few days. Until it passes, Google shows the name without the logo.
- A repo to test pull-request review on.
- How Free credits should run out sooner (section 7).
- New keys in place of the four that were pasted into chat.
- For later: a model key with balance, the Polar account, the legal pages.

---

## 13. Launching the beta

Picture: GoDraw, page 5, "The path to the beta".

The beta runs on the AWS server and on Vercel. Beta users connect their own Claude plan, so payments and a model key are not needed yet. After the beta is tested, the server moves to the VPS.

The domain is `textcrew.in`. In the steps below, `yourdomain` stands for it.

**Progress on 8 October 2026**

| Part | State |
|---|---|
| A. Domain | Done. `api.textcrew.in` points at the AWS server. `docs/domain-setup.md` explains the DNS |
| B. Web app on Vercel | Done. It is live at `https://app.textcrew.in`, as the Vercel project `textcrew-app`. A push to GitHub does not deploy by itself yet; Claude deploys it from the terminal |
| C. Server | Done. It answers at `https://api.textcrew.in`, Textcrew AI is off, and 8 containers may be awake at once |
| D. Outside services | The Telegram bot is moved. Clerk's webhook is on the new address: the first sign-up arrived through it. Composio's webhook address is yours to change (step 11); not confirmed yet. On 15 October sign-in moved to Clerk's production setup (below step 12) |
| E. First real run | Started. A real sign-up made the account, gave 100 credits and created the container. The Claude plan was connected in the web app, and the first web chat message was answered in about 5 seconds. Left: link Telegram, connect an app, and the same on a phone (steps 15 to 18) |
| F to H | Not started |

**Since 15 October,** sign-in runs on Clerk's production setup. Accounts made before do not carry over, so step 13 has to be done once more, on the production setup.

### Part A. Your domain

1. In your domain's DNS settings, add a record: name `api`, type A, value `3.111.132.222`. This makes `api.yourdomain` point at the AWS server.
2. Tell Claude the domain. The second record, for `app`, comes in step 6.

### Part B. The web app on Vercel

3. In Vercel, create a new project from the GitHub repo `personal-agent-web-frontend`.
4. In the project's settings, add four environment variables:

   | Name | Value |
   |---|---|
   | `TEXTCREW_API_URL` | `https://api.yourdomain` |
   | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | The same value as in `beckend/.env.deploy` |
   | `CLERK_SECRET_KEY` | The same value as in `beckend/.env.deploy` |
   | `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` |

5. Deploy.
6. In Vercel, under the project's Domains, add `app.yourdomain`. Vercel shows one DNS record to add. Add it in your domain's DNS settings.

### Part C. The server

7. Start the server. In AWS CloudShell (Mumbai): `aws ec2 start-instances --instance-ids i-0283ac551a5204d47`. Claude can do this for you.
8. If SSH does not answer, your home address has changed. Replace the port 22 rule with the commands in `aws-setup.md`, section 13.
9. Claude then does these on the server:
   - changes the server's address from `3-111-132-222.sslip.io` to `api.yourdomain`;
   - sets the web app's address, `https://app.yourdomain`, in the two settings that need it;
   - turns Textcrew AI off, if you agree, so every beta user must connect a Claude plan;
   - raises the limit of containers awake at once from 3 to 8, and watches the server's memory;
   - deploys, and checks that the site answers.

### Part D. The outside services

10. In the Clerk dashboard, change the webhook's address to `https://api.yourdomain/webhooks/clerk`. It must send `user.created`, `user.updated` and `user.deleted`.
11. In the Composio dashboard, change the webhook's address to `https://api.yourdomain/webhooks/composio`.
12. Claude points the Telegram bot's webhook at the new address.

**Done on 15 October 2026: Clerk's production setup.** Until then the Clerk app in use was its development setup, with test keys. Now:

| What | State |
|---|---|
| Clerk's production setup for `textcrew.in` | Live. Clerk answers at `clerk.textcrew.in` |
| Five DNS records for Clerk | Added at Vercel. `domain-setup.md`, section 4, lists them |
| Textcrew's own Google sign-in app | Published. Google's screen names Textcrew, not Clerk. Logo uploaded. Left: Google's brand check (ask again from 16 October; a few days) |
| Clerk's webhook | A new one on the production setup, to `https://api.yourdomain/webhooks/clerk`, for the same three events |
| The live keys | On the server, in Vercel's production settings, and in the laptop's `.env.deploy` and `.env` |
| A real sign-up on it | Not yet done |

Everyone signs up again: accounts from the development setup do not carry over. Signing in on the laptop (`localhost`) needs the old test keys, which are kept in the laptop's `.env` as commented lines.

### Part E. The first real run

13. On a laptop: open `https://app.yourdomain`, sign up, and check that the account appears.
14. Connect your Claude plan in Settings.
15. Ask for a Telegram link code and send it to the bot.
16. Send a message on Telegram and get a reply.
17. Connect one app, for example Gmail, and ask the agent to do something in it.
18. Repeat steps 13 to 16 on a phone.
19. Claude fixes what breaks.

### Part F. Before inviting people

20. Decide on findings 1 and 2 in section 12. Claude builds the fixes and deploys.
21. Name a repo. Claude tests pull-request review on it, with you.
22. Make new keys in place of the four pasted into chat. Claude puts them on the server.
23. Decide how many credits a beta user starts with. Claude can give extra credits with a coupon code.
24. If beta users should be able to bring an API key in place of a Claude plan, Claude finishes that way first. Today the key is saved but the engine does not use it. Testing it needs one API key with balance.

### Part G. The beta

25. Invite the first users. Start with a few.
26. Leave the server running. It costs about $2.50 a day from the AWS credits. The credits last about a month.
27. Watch the first days together: the logs, the activity of each user, memory use on the server.

### Part H. After the beta: the move to the VPS

28. Order the VPS (Contabo Cloud VPS 6, Ubuntu 24.04). Check first that your card is accepted.
29. Claude sets it up like the AWS server, copies the database and the users' files, and runs the same tests.
30. Change the `api` DNS record to the VPS address. Users see no change.
31. Stop the AWS server.

The VPS that was planned:

| | |
|---|---|
| **Which** | Contabo Cloud VPS 6: 6 shared vCPU, 12 GB RAM, 200 GB SSD |
| **Cost** | About $12.5 a month with GST. Check the price at checkout |
| **Where** | Singapore or Mumbai |
| **How many users** | About 15 to 20 containers awake at once. That is roughly 150 to 250 users in total. Not measured yet |
| **Set up with** | SSH by key only, the firewall open on ports 22, 80 and 443 only, automatic security updates, Docker and gVisor |
| **Backups** | Contabo's two snapshots, plus backups stored outside the server |

### Not part of the beta, needed before a public launch

- Payments through Polar.
- A model key with balance, for Textcrew AI.
- Backups outside the server, with a tested restore.
- An alert channel.
- A size limit on each user's files.
- The legal pages, and Anthropic's written OK for the Claude plan option.
- Google's review of our own Google sign-in app: Google Calendar first (free), then Gmail and Drive with the yearly security check (CASA). Until then those apps use Composio's shared sign-in, whose name shows on Google's screen.
- Joining the landing page's waitlist to the backend, so the 50% waitlist discount works.
