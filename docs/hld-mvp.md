# Textcrew MVP: the design

This file explains what Textcrew is, what its parts are and how they work together. It is written to be read from top to bottom.

Five files make up the docs:

| File | What it holds |
|---|---|
| `hld-mvp.md` (this file) | The product, the parts, the main flows, the decisions, and the steps to launch the beta |
| `backend-report.md` | Every piece of logic in the backend, explained in words, with no code |
| `aws-setup.md` | The test server: what was done, the commands, the problems and their fixes |
| `domain-setup.md` | The domain `textcrew.in`: where it was bought, who answers DNS, each name, and how to add or move one |
| `engines-proposal.md` | A proposal, not built: adding Codex and other bring-your-own engines, with OpenAI's rules and the decisions to make |

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
- **Start a new chat.** The "New chat" button in the web app, or the message `/new` on Telegram. The agent then does not see what was said before in that chat. Its saved notes about the user stay. It costs nothing.
- **Keep a history of conversations.** Each new chat is its own conversation, with its own context. The web app lists them, named after their first message. The user can open an earlier web conversation and go on writing in it: the agent continues that conversation, not the latest one. Example: open last week's "Plan a trip to Goa" and ask "and the hotel?". Telegram conversations are in the list for reading.
- **Rename or delete a conversation.** Deleting one removes its messages and files.
- **Get real work done in apps.** The agent can act in about 25 apps. Example: "Email Priya the meeting notes."
- **Stay in control.** Before the agent sends something to another person, deletes something or pays, it asks first.
- **Set reminders and automations.** Once, on a schedule, or when something happens in an app. Example: "Every Monday at 9, send me my open pull requests."
- **Use a crew.** The agent you text is called Tex. Tex can hand work to three specialists: Byte writes code, Patch reviews code, Scout researches.
- **Get pull requests reviewed.** Turn it on for a GitHub repo. When a pull request opens, Patch reviews it and comments on it. You get a short verdict in chat.
- **Research on the web.** Scout searches and reads pages. On the Max plan Scout can also drive a real browser.
- **Be remembered.** The agent keeps short notes about you, and you can see and delete them.
- **Bring their own AI.** A Claude plan or an API key. Then the AI part costs no credits.
- **Choose Claude's model and effort.** With a Claude plan, the user picks the Claude model and how hard it thinks, called the effort. Example: Opus 5.5 at effort "xhigh". Left at "Default", Claude Code chooses.

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
| Postgres | The database: users, messages, credits, the activity log |
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

### 5.2 One message, from start to end

Picture: GoDraw, page 2, "One message".

Example: the user texts "email Priya the notes".

1. Telegram calls our server with the message.
2. The api checks that the call really comes from Telegram. It saves the message once, adds a job, and answers Telegram at once.
3. The worker takes the job. It locks this user, so that only one turn runs for them at a time.
4. The worker checks the user's credits. At zero, the user gets a short "out of credits" reply and the container is not started.
5. The worker asks the vm-manager to wake the user's container. This takes a few seconds if it was asleep.
6. The vm-manager hands the message to the Bridge inside the container. The Bridge gives it to the agent.
7. The agent works. It may call tools, and Tex may hand parts to the crew. Short progress lines go to the chat.
8. The agent gives its final reply. The worker sends it to Telegram.
9. The worker counts what was used and charges credits.
10. After 3 idle minutes the container stops. The user's files stay.

**Why the api and the worker are separate:** Telegram expects an answer within seconds. So the api only saves the message and answers. The slow work happens afterwards in the worker. If the worker crashes, the job is still in the queue and runs again.

### 5.3 The agent does something in an app

1. The user connects an app once, in the web app. They approve access on that app's own screen. We never see their password.
2. Later the agent wants to act, for example send an email.
3. The agent calls our tool for app actions. The api, not the container, calls Composio. So the keys for apps never enter a container.
4. If the action is risky, the tool refuses and tells the agent to ask first. Risky means: sending to another person, deleting, or paying.
5. The agent asks. The user sees "Approval needed" with Approve and Reject buttons.
6. The user's answer arrives as a new message. The agent then runs the action, exactly as it was approved.
7. An action that changes something costs 1 credit. Reading and searching are free.

An approval works once, and only for the exact action and details the user saw.

### 5.4 A reminder or an automation

There are three kinds:

| Kind | Example | What starts it |
|---|---|---|
| Once | "Remind me Friday at 10" | A timer |
| Repeating | "Every Monday at 9, list my open pull requests" | A schedule in the user's time zone |
| App event | "When my boss emails me, tell me" | Composio tells us the event happened |

When one fires, it goes down the same path as a normal message, with the saved instruction. So it wakes the container and costs credits like a message does.

An automation pauses itself at zero credits, or after three failures in a row. The shortest allowed interval is 15 minutes.

### 5.5 A pull request gets reviewed

1. The user turns review on for one GitHub repo, in the web app.
2. Someone opens a pull request there, or pushes new commits to one.
3. Composio tells our server.
4. The worker wakes the user's container and tells Tex to have Patch review that pull request.
5. Patch reads the changes and posts one review with its comments on the pull request.
6. The user gets a short verdict in chat.

Each commit is reviewed once. Patch never merges and never approves. Turning review on is the user's standing permission for these comments, on that repo only.

### 5.6 Research and the browser

- Only Scout touches the web. Scout has no files, no shell and no app tools, so a web page cannot trick it into sending or deleting anything.
- If the user's engine has its own web search, Scout uses that. This is the case on Claude Code. It costs no credits.
- Otherwise Scout uses our search, which runs on Brave. That is part of the Max plan and costs 1 credit per search.
- Scout can read a web page through our page reader. That is free on every plan.
- On the Max plan Scout can drive a real browser, for pages that need clicking or JavaScript. The browser runs inside the user's own container and costs 2 credits per minute.

### 5.7 The container sleeps and wakes

Picture: GoDraw, page 3, "The life of a container".

- A container is stopped most of the time. A stopped container costs nothing.
- A message, a reminder or an app event wakes it.
- While a turn runs, the container is never stopped.
- After 3 idle minutes it stops again. Its files are kept.
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
9. **Risky actions need the user's yes.** Sending to others, deleting, paying.
10. **Secrets are encrypted in the database.** Tokens and codes are stored only as fingerprints that cannot be turned back.
11. **Everything the agent does is written to the activity log.**

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

---

## 10. Rules from other companies

Other companies' rules decide part of what we can launch. These were read on 2 October 2026. Rules change, so check them again before a public launch.

| Company | The rule | What it means for us |
|---|---|---|
| **Meta (WhatsApp)** | AI assistants are not allowed on WhatsApp's business platform outside Europe | Not a launch channel. The code stays switched off |
| **Telegram** | AI bots are allowed. Digital goods sold inside Telegram must be paid with Telegram Stars | Our launch channel. The bot never sends a purchase link. Plans are bought on the website |
| **Apple (iMessage)** | No safe route for a bot with no human behind it | Not at launch. Maybe later, clearly labelled as a beta |
| **Anthropic (Claude plans)** | Running Claude Code for users is allowed with conditions: the program is not modified, each user signs in with their own plan, and we never pay for or resell their usage | Offered as a beta. Two things to do: accept Anthropic's Commercial Terms, and ask them in writing whether our setup is within the rule |
| **Google (Gmail)** | An app that reads Gmail must be verified by Google. Until then it stops at 100 new users | The beta uses Composio's shared Google app. Our own verification must start before we grow |
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
- A real sign-up through Clerk in the web app at `https://app.textcrew.in`: the account, the 100 sign-up credits and the container were made.
- Connecting a Claude plan in the web app, and a web chat message answered by the agent.
- Tested on 8 October (on a test account): a reminder that fires, a daily automation created and cancelled, the 15-minute limit, a free GitHub read, an approval approved (an email sent) and one rejected, memory saved, recalled and forgotten without naming the tool, a password refused as a memory, Scout reading pages on Claude Code, the browser, out of credits, "connect your own AI first" for a user with none, the idle stop (3 minutes 11 seconds), and the isolation test (5 of 5).
- A request Anthropic refuses gets a clear reply, is not counted as our fault and is not kept in the chat's history.
- A new chat from the web app's code path, and Claude Code running with the model and effort chosen in Settings (Opus 5.5 at "xhigh" was checked on the running process).

### Built, never run for real

- Textcrew AI on the Hermes engine. There is no working model key.
- The user's own API key. Every model call goes to the user's provider with their key, through LiteLLM on our server. There is no key with balance to test it.
- Payments through Polar.
- Pull-request review, and Byte pushing code through our git gateway.
- A memory saved on one engine and used on the other.
- The history of conversations: the list, going back to an earlier one, rename and delete. Built on 9 October.
- The app list telling the web app which apps can be connected on this server (only those with a Composio setup: today Gmail and GitHub).
- Web search through Brave. The key works; the path through the app has not run.

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
- **The desktop app:** leave it out of the beta (recommended), then a thin shell around the live web app. Never bring the separate copy up to date. Its 22 commits are only on the laptop, on branch `feat/desktop-app`.
- **Codex and other engines:** see `engines-proposal.md`, section 10. A ChatGPT plan cannot be used yet; OpenAI must approve first.
- **A Clerk production instance on `textcrew.in`:** needed before a public launch, and it makes the first visit about a second faster.

### Smaller open questions

- **Textcrew AI:** which models to offer, and whether 2.5 times cost is the right price.
- **Memory:** may the agent save a memory in a turn the user did not start, such as an incoming email? May the user add or edit memories in the web app?
- **The page reader on Claude Code:** keep it open to any public address, or go back to the strict rule (see `backend-report.md`, section 43).
- **The page reader on Hermes:** it refuses a redirect to an address it has not seen, even on the same site. Keep that, or allow redirects inside one site?
- **Signing in to websites in Scout's browser:** wanted as the next step. Open: how long a sign-in is kept, which sites, and what Scout may do there without asking.
- **The waitlist form** still asks about WhatsApp and iMessage. Keep it as a signal of demand, or change it.
- **Composio:** on its project, "mask connected account secrets" must be off, or the git gateway and pull-request review cannot work.
- **Pull-request review** needs admin access to the repo, because Composio puts a webhook on it.
- **Small gaps the web app found in the API:** no history of past reviews, no list of repos to pick from, no way to add or edit a memory, and progress lines are not shown again after a page reload.

### Also waiting on you

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
| D. Outside services | The Telegram bot is moved. Clerk's webhook is on the new address: the first sign-up arrived through it. Composio's webhook address is yours to change (step 11); not confirmed yet |
| E. First real run | Started. A real sign-up made the account, gave 100 credits and created the container. The Claude plan was connected in the web app, and the first web chat message was answered in about 5 seconds. Left: link Telegram, connect an app, and the same on a phone (steps 15 to 18) |
| F to H | Not started |

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

The Clerk app in use is a test app (its keys start with `pk_test` and `sk_test`). That is enough for the beta. A public launch needs a Clerk production app on your own domain.

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
- The legal pages, Anthropic's written OK for the Claude plan option, and Google's verification for Gmail beyond 100 users.
- Joining the landing page's waitlist to the backend, so the 50% waitlist discount works.
