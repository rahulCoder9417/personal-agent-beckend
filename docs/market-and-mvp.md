# Market and MVP: how the other agents work, and what Textcrew should launch

Written 2026-10-02. This document covers the AI agent products on the market (Dots, Grok Bot, Muse and the rest), how they work, the platform rules that decide what we are allowed to launch, where Textcrew stands today, and what the MVP should do and say.

**How the research was done.** Four research passes over the public web on 2026-10-02: the three products named by the founder, the other big labs, the assistants you reach by text, and the platform rules. Every fact has a source in section 12. Two rules decide the MVP, and those two pages were read directly: Meta's WhatsApp Business terms and Anthropic's Claude Code legal page. Everything else was read through a tool that summarises pages, so check any quote against its source before publishing it. Section 11 lists what could not be confirmed.

## Contents

1. [In short](#1-in-short)
2. [How these agents work](#2-how-these-agents-work)
3. [The big labs](#3-the-big-labs)
4. [Assistants you text](#4-assistants-you-text)
5. [What people use them for, and what they complain about](#5-what-people-use-them-for-and-what-they-complain-about)
6. [The rules that decide what we can launch](#6-the-rules-that-decide-what-we-can-launch)
7. [Where Textcrew stands today](#7-where-textcrew-stands-today)
8. [Positioning: who it is for and what to say](#8-positioning-who-it-is-for-and-what-to-say)
9. [The MVP](#9-the-mvp)
10. [Launch checklist](#10-launch-checklist)
11. [Could not verify](#11-could-not-verify)
12. [Sources](#12-sources)

---

## 1. In short

1. **Everyone is building the same thing.** OpenAI (Dots), xAI (Grok Bot), Meta (Muse), Google (Gemini Spark), Microsoft (Autopilot) and Perplexity (Computer) all give each user an always-on agent with its own cloud computer, connected apps, memory, schedules and approval before risky actions. Our container-per-user design is the same idea.
2. **They are expensive, US-first and mostly not textable.** Prices cluster at $20 and $100 to $200 a month. Muse is US-only; Dots and Spark exclude the EU and UK. You reach them through their own apps. Only Muse is reported inside WhatsApp, and Meta owns WhatsApp.
3. **WhatsApp is closed to us.** Meta's terms prohibit AI assistants from the WhatsApp Business Platform when the AI is the primary function. The exception is the EEA under an interim order, and possibly Brazil. We cannot launch on WhatsApp in India, the US or most of the world.
4. **iMessage has no safe route.** Apple's official channel requires live human support and Apple's approval. The unofficial services can be cut off without notice.
5. **Telegram is the one channel we can launch on today.** There is no rule against AI bots. Payments for digital goods inside Telegram must use Telegram Stars, so checkout stays on our website.
6. **"Bring your Claude plan" is allowed, with conditions.** Anthropic permits a platform to host the unmodified Claude Code with each user signing in to their own subscription, if we accept the Commercial Terms and never pay for or resell the usage. The rule changed three times in 2026. Treat it as a beta feature and lead with the user's own API key.
7. **Gmail access is capped at 100 users** until our own Google app passes verification and a yearly security assessment.
8. **The direct competitors** (Poke, Pally, Martin, Tomo, Catch) charge $19 to $99 with the AI included and are iMessage-first. None of the main four markets coding from chat, a named crew of agents or bring-your-own AI.
9. **Recommended MVP:** a Telegram-first agent for developers and founders who already pay for an AI model. It handles inbox, calendar and reminders, and ships small code changes as pull requests. Tex leads, with Scout (research) and Patch (code) as the crew. Plans stay at $0 / $12 / $30.
10. **The landing page needs to change** before launch: it leads with WhatsApp and iMessage, promises six specialists and about 25 apps. Section 9.4 lists the edits.

---

## 2. How these agents work

Almost every product in this document is built from the same six parts.

| Part | What it means | How the big labs do it | How Textcrew does it |
|---|---|---|---|
| **A computer per user** | The agent needs somewhere to run commands, keep files and stay logged in | A dedicated cloud VM per user (Dots, Muse, Spark, Autopilot, Perplexity) | A sandboxed container per user (gVisor), with the user's own disk volume. It sleeps after 3 idle minutes |
| **Ways to use apps** | How the agent reads mail, books meetings, files issues | Connectors (APIs) first, then driving a browser or desktop like a person where no API exists | Connectors only, through Composio. No browser or desktop control yet |
| **Approvals** | The agent asks before sending, deleting, paying | Universal. Newer designs add a second system that checks every action (OpenAI's auto-review, Meta's Sentinel) | Built: the agent requests approval and the user answers with a button or yes/no |
| **Memory** | It remembers preferences and past work | Universal | Built into the engine (Hermes or Claude Code), stored in the user's volume |
| **Schedules and triggers** | Work that runs later or on an event | Time schedules everywhere. Event triggers are thin (Gmail filters at Google, GitHub at Anthropic, price at Amazon) | Built: one-off reminders, recurring schedules and app-event triggers |
| **A way to reach it** | Where the user talks to the agent | Their own apps and web. Slack and Teams for work. Texting is rare | Telegram (live-tested). WhatsApp and iMessage code exists but is not launchable (section 6) |

Two differences matter for us:

- **We don't have computer use.** The big labs' agents can open a browser and click through any website. Ours can only use apps that have a connector. That limits Scout: it can search and read pages, but it cannot log in to a site and work there.
- **We don't pay for the AI.** In all the big-lab products the model is included in the plan. In Textcrew's MVP the user brings their own API key or Claude plan, and our credits pay for the container's awake time and paid tools only (HLD section 7).

---

## 3. The big labs

### 3.1 Comparison

| Product | Launched | Where it runs | How you reach it | Can you text it? | Price | Where |
|---|---|---|---|---|---|---|
| **Dots** (OpenAI) | 29 Sep 2026 | Its own cloud computer and browser per dot | ChatGPT desktop and mobile apps, Slack, Teams | SMS is "coming soon" or a limited US beta (OpenAI's pages differ) | Included in ChatGPT Pro and Business Premium only | Pro rollout excludes the EEA, Switzerland and the UK |
| **Grok Bot** (xAI, with Cursor) | 11 Aug 2026, beta | A persistent cloud computer in the US | Its own desktop and iOS apps. Slack for team plans | No | Included in SuperGrok and Cursor paid plans, with a weekly allowance | Not published |
| **Muse** (Meta) | 8 Sep 2026 | A dedicated VM per user | iOS, Android, muse.ai, and reportedly WhatsApp | Reportedly yes, in WhatsApp | Free, $20, $100 | US only |
| **Gemini Spark** (Google) | 19 May 2026, experimental | Dedicated VMs on Google Cloud | Gemini mobile, Mac and web apps | No (launch coverage mentioned an email address) | Needs AI Pro ($20) or Ultra | Not in the EEA, UK or Switzerland |
| **Claude Cowork** (Anthropic) | Web and mobile 7 Jul 2026, beta | Anthropic's servers; local files need the desktop app | Claude apps, web, Chrome extension, Slack | No hosted option. A Telegram and iMessage bridge exists but only works while a session is open on your own machine | Pro $20, Max from $100 | Not found |
| **Copilot Cowork / Autopilot** (Microsoft) | Autopilot 25 Sep 2026, private preview | Cloud-hosted with its own computer (Autopilot) | Copilot app, Teams | Copilot Tasks had SMS; it is being removed in the move to Cowork | Premium or Pro plans | Not found |
| **Perplexity Computer** | 25 Feb 2026 | An isolated VM per session | Web, apps, Slack, email | No (email only) | Max $200 | Not found |
| **Alexa+** (Amazon) | US 4 Feb 2026 | Amazon's services; no per-user VM found | Echo devices, Alexa app, Alexa.com | No | Free with Prime, otherwise $19.99 | 11 countries, including India since 16 Sep 2026 |
| **Manus / Cue** | Cue 28 Sep 2026 | Its own computer per agent | Apps, Telegram (since Feb 2026) | Yes, Telegram | Free tier; $20 for 4,000 credits | Not found |

Meta's purchase of Manus was blocked by China in April 2026, so Manus is independent again.

### 3.2 Dots (OpenAI)

- **What it is.** Always-on agents inside ChatGPT. You give a dot a job and it works in the background, on its own cloud computer and browser. It runs scheduled and recurring tasks and does background research on its own.
- **Apps.** "Over 4,000 apps" through plugins, plus its own browser for sites with no plugin.
- **Approvals.** You set a rule per action: act without asking, ask first, or hand off to you. A separate review system checks actions before they run. Permanent deletion, purchases with saved cards and new security access are always confirmed. Password changes and money transfers are handed back to the user.
- **Crew.** One dot per plan today. "Specialist dots" with their own identity and logins (procurement, invoicing, support) are in enterprise pilots.
- **Limits.** Creating a dot needs the desktop app or desktop web. It can't call you and has no email address of its own.
- **Early reviews.** One hands-on review reported about 2 hours of work for about 15 minutes of input. Complaints collected by a blog: repeated confirmations, slow, can't fetch 2FA codes.
- **What it means for us.** This is the closest design to ours from the largest company. It is locked to OpenAI's top plans, excluded from Europe, and texting isn't broadly live.

### 3.3 Grok Bot (xAI)

- **What it is.** "AI teammates" with a persistent cloud computer (browser, files, terminal), built with Cursor. It keeps working with your laptop closed.
- **Apps.** Connectors where they exist, and computer use for everything else. You can show it a workflow once and save it as a scheduled skill.
- **Approvals.** Allow once, always allow, or deny, per action. An automatic reviewer can block shell commands and computer use. Logins, 2FA and payments are handed to the user.
- **Crew.** Several named bots, group chats of two to six bots, and bots that hand tasks to each other. This is the most developed "team of agents" among the big labs.
- **Limits.** One computer-use task per bot at a time. Sites can block automation.
- **Not the same as Grok in Telegram.** The Grok inside Telegram and X is a chatbot: it answers, searches and summarises. It has no computer and takes no actions in your apps.
- **What it means for us.** Grok Bot proves the "named crew" idea is real, but it lives in its own app and you can't text it.

### 3.4 Muse (Meta)

- **What it is.** Meta's personal agent, launched in the US on 8 September 2026. Each user gets a dedicated VM that holds the agent and their data. A second agent, Sentinel, runs on the same machine and must approve anything that reaches the internet.
- **Apps.** Connectors for email, calendar, payments, health, smart home and shopping, plus its own browser. Partners include Stripe, Shopify, PayPal, GitHub and Notion.
- **Approvals.** It checks before sending email or buying, and keeps a full audit trail.
- **Price.** Free, Power at $20 and Max at $100 a month, with weekly usage limits.
- **Trouble so far.** Amazon blocked it as an "unauthorized AI agent". Press coverage questions whether consumers will trust Meta with this much access.
- **What it means for us.** Muse is the only big-lab agent reported inside WhatsApp, and Meta bars everyone else from WhatsApp (section 6.1). In the US, a free Muse inside WhatsApp is the hardest competitor for a consumer assistant.

### 3.5 Patterns

- **A cloud computer per user is the default.** Anthropic moves Cowork tasks to the cloud on 6 October 2026.
- **Approval before sending, spending or submitting is universal.** It is expected, so it is not a selling point on its own.
- **Messaging is their weakest surface.** That is the space the text-first startups (section 4) and Textcrew are in.
- **Rollouts are US-first.** India gets Alexa+ and little else in this category.
- **Costs are hard to predict.** Reviewers complain about credit and compute limits across these products.

---

## 4. Assistants you text

These are the direct competitors: products whose main way in is a message.

| Product | Channels live | Price per month | Standout | Biggest weakness |
|---|---|---|---|---|
| **Poke** | iMessage, SMS/RCS, Telegram; WhatsApp in limited markets | Free / $19 / $199 | Personality, custom MCP servers, scale (100M+ messages in three months) | Reliability complaints; bought by Cognition in July 2026 and being folded into it in 2027 |
| **Pally** | iMessage, RCS, Telegram, WhatsApp | Free / $25 / $100 | Widest channel mix and a real free tier | Low automation caps (3 free, 10 on Pro) |
| **Martin** | SMS, phone, WhatsApp, Slack, email, iOS app | $35 / $49 | Calls and texts other people for you | Price; slow support |
| **Tomo** | iMessage, iOS app | Free / $19.99 | Habit and goal coach | iOS only; price shown late |
| **Catch** | iMessage/SMS, WhatsApp, Slack, Teams, email, phone | $99 | Executive admin with outbound calls | Price; launched September 2026 |
| **Arlo** | iMessage/SMS, WhatsApp, Slack, Teams, phone | Credits ($20 plan) | Approval on every send, per-action prices published | Work-team focus |
| **Lindy** | Slack, iMessage, email | $29.99 / $99.99 / $199.99 | 1,000+ integrations | Credit burn and cancellation complaints |
| **Carly** | Email first; SMS, Slack | Free / $35 | You CC it on email | Not chat-app-first |
| **Zo Computer** | iMessage/SMS, email, Telegram, Discord, Slack | $18 / $64 / $200 | A full cloud Linux machine; bring your own key | Learning curve |
| **Notis** | WhatsApp, Telegram, iMessage, Slack, email | Not published | Connects your ChatGPT or Claude subscription | Prices not shown |
| **OpenClaw** | WhatsApp, Telegram, Signal, iMessage, Discord, Slack | Free, self-hosted | Open source, codes and opens pull requests | You set it up and secure it yourself |
| **Puch AI** (India) | WhatsApp | Free | 21 Indian languages | A chatbot; no app connections found |
| **Zapia** (Latin America) | WhatsApp, apps | Not found | Claims 7M users | No India presence found |

What stands out:

- **They are iMessage-first and US-first.** That is where their customers are, and it is the channel we can't safely use.
- **The AI is included in the price.** A user pays $19 to $35 and nothing else. With Textcrew a user pays $12 and also pays for their own AI. Our total is only cheaper for someone who already has an API key or Claude plan.
- **How several of them offer WhatsApp is not explained** given Meta's rule. Poke's own launch coverage says WhatsApp is restricted in most markets.
- **Poke's exit shows the value.** It raised $25M, reached "hundreds of thousands" of users and sold for a reported low nine-figure sum within four months of launch.

---

## 5. What people use them for, and what they complain about

**Jobs, ranked by how often they appear in marketing and reviews:**

1. Inbox triage and drafting replies
2. Calendar scheduling and rescheduling
3. Reminders and follow-up nudges
4. A morning brief and meeting prep
5. Research and web answers
6. Phone calls and bookings on your behalf
7. Capturing tasks and notes into Notion, Todoist or Linear, often by voice note
8. Habit and goal accountability
9. Developer chores and coding
10. Shopping and ordering

Coding is ninth. It is a gap in the market because few offer it, not because most users ask for it.

**Complaints, from app-store, Product Hunt and Trustpilot reviews:**

- **Unclear cost.** Credits that run out unpredictably, and prices revealed late (Lindy, Tomo, early Poke).
- **Not proactive.** "Wasn't really useful and never proactive" (Poke).
- **Basic mistakes.** Time zones, dates, missed meetings.
- **Unfinished features.** "Not everything it says it can do is equally fully implemented yet" (Martin).
- **Support and cancellation.** Weeks to get help (Martin); no working cancel option (Lindy).

**Gaps nobody fills well:**

- A hosted product that markets "text me and I open the pull request".
- A named team of agents, among the consumer text assistants.
- Bring your own AI, outside Zo, Notis and self-hosted OpenClaw.
- Per-action prices shown to the user (only Arlo and Notis publish them).
- An app-connected agent priced for India.

---

## 6. The rules that decide what we can launch

### 6.1 WhatsApp: not allowed outside Europe

Read directly on 2026-10-02. Meta's WhatsApp Business Platform terms, section 4.7 (last modified 23 September 2026):

> "Providers and developers of artificial intelligence or machine learning technologies, including but not limited to large language models, generative artificial intelligence platforms, general-purpose artificial intelligence assistants, or similar technologies as determined by Meta in its sole discretion ("AI Providers"), are strictly prohibited from accessing or using the WhatsApp Business Platform … when such technologies are the primary (rather than incidental or ancillary) functionality being made available for use, as determined by Meta in its sole discretion; provided, however, that such technologies may be made available to businesses in certain countries as set forth here."

- **In force** since 15 January 2026 for existing users.
- **Still allowed:** AI that is incidental to a business's own service, such as customer support or order tracking.
- **Who it caught:** press named OpenAI, Perplexity, Luzia and Poke. Poke is a task agent like ours.
- **Europe:** on 9 June 2026 the European Commission ordered Meta to restore access for third-party AI assistants in the EEA until its final decision. Italy and Brazil took their own action. No action by India's regulator was found.

**For Textcrew:** an AI agent is our primary function, so WhatsApp is not available in India, the US or most of the world. It may be possible for EEA users while the interim order lasts. Do not launch on it or lead the landing page with it.

### 6.2 Telegram: allowed

- **No rule against AI bots.** The bot developer terms require a privacy policy and that user data is encrypted at rest.
- **Limits:** about 1 message a second per chat and about 30 a second overall.
- **Payments:** "All payments via bots and mini apps for digital goods and services inside Telegram apps must exclusively use Telegram Stars." A bot that sells digital goods another way can be hidden from mobile users.
- **Unclear:** whether a subscription bought on our website is caught when the bot sends the checkout link.

**For Textcrew:** this is the launch channel. Keep sign-up and Polar checkout on the web app, and have the bot say "manage your plan in the web app" without a purchase link. Add Telegram Stars later if in-chat purchase matters.

### 6.3 iMessage: no safe route

- **Official route (Apple Messages for Business):** Apple's policy says a business "must not provide a limited or bot-only solution" and must provide a live human agent. Poke was approved in June 2026 as the first AI agent, after a couple of months and with live support in place.
- **Unofficial route (Sendblue and similar):** these run real Apple devices and Apple IDs. Lindy reported its account was permanently banned on launch day.

**For Textcrew:** our Sendblue integration works technically, but Apple can cut it off without appeal. Offer it later as a clearly labelled beta, never as a launch promise.

### 6.4 SMS: not for launch

- **US:** needs A2P 10DLC registration with a business tax ID. It is unclear whether an Indian company qualifies.
- **India:** needs sender and template registration with the operators, which does not fit free-form AI replies.

### 6.5 Claude plans: allowed, with conditions

Read directly on 2026-10-02. Anthropic's Claude Code legal page, under "Can customers offer Claude Code in their products?":

> "Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below:
>
> - The Claude Code binary must not be modified. …
> - Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential…"

And under "Authentication and credential use":

> "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow. … Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code…"

**How our build compares:**

| Condition | Our build |
|---|---|
| Unmodified binary | Yes. Installed with Anthropic's installer at a pinned version and checked against the signed manifest |
| No authentication method removed, disabled or restricted | **Needs a change or a ruling.** Our launcher hides API-key and cloud-provider variables from Claude Code, so only the subscription sign-in is used there; a user's API key goes to Hermes instead. That may count as restricting a built-in method |
| We don't pay for or resell usage | Yes. Each user signs in with their own plan |
| Commercial Terms accepted | **Not done yet** |
| Sign-in completes through Anthropic's flow | The user approves on Anthropic's page. The one-time code then passes through our API into Claude Code in their container. **Grey area** |
| We don't store credentials | Claude Code stores its sign-in in the user's own volume, on our server. **Grey area** |
| No Anthropic names or logos in our branding | The page may say, in plain text, that it "runs Claude Code". Nothing more |

- **History:** Anthropic blocked subscription tokens outside Claude Code in January 2026, tightened the wording in February, and stopped covering third-party harnesses in April. The current page is more permissive than February's.
- **Usage limits** "assume ordinary, individual usage". An always-on agent may be read as more than that.
- **Enforcement:** "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

**For Textcrew:** make the user's own **API key** the main, recommended path. With Hermes it involves no Claude Code conditions at all. Offer the Claude plan as a beta. Before launch, accept the Commercial Terms and ask Anthropic sales in writing whether a messaging gateway in front of hosted Claude Code is within the rule. The page invites that question.

### 6.6 Google (Gmail and Calendar): capped at 100 users until verified

- **Restricted scopes:** reading or modifying Gmail (`gmail.readonly`, `gmail.modify`, `gmail.compose`). Sending only (`gmail.send`) is a lighter "sensitive" scope.
- **Our own Google app** would need verification plus a security assessment by a Google-approved assessor, repeated every 12 months. One blog puts the cost at $540 to $1,800 a year.
- **Unverified apps** are capped at 100 new users.
- **Composio's shared app:** Composio's docs say to use its managed authentication for development and "generate your own OAuth credentials" for production. On the shared app the consent screen says "Composio wants to access your account" and the quota is shared.

**For Textcrew:** run the closed beta on Composio's managed app, and start our own Google verification now, because inbox triage is the most-used job and it needs the restricted scopes.

### 6.7 Polar: allowed, expect a review

- **Fees:** 5% + 50¢ per sale on the Starter plan, plus 1.5% for non-US cards, plus payout fees.
- **India** is supported for seller payouts.
- **Review:** AI tools get closer review. Polar prohibits "services to circumvent the rules, paywalls or terms of other services", which is another reason to stay off unofficial iMessage and non-compliant WhatsApp.
- **Credits:** Polar supports prepaid credits but does not block usage at zero. Our own ledger already does that.

### 6.8 Open-source engines and security

- **Licences:** Hermes Agent and OpenClaw are both MIT. Commercial hosted use is allowed.
- **Incidents in 2026:** a prompt-injection CVE in Hermes (below version 0.15.0), a flaw that let a website hijack a local OpenClaw gateway, and 71 malicious skills found on OpenClaw's skill marketplace.

**For Textcrew:** our design already keeps keys out of the container and limits its network. Still to do: confirm our pinned Hermes version against that CVE, keep third-party skill marketplaces off, and stop exposing `/mcp` and `/git` to the public internet.

### 6.9 India

- **Data protection (DPDP):** the rules were notified on 14 November 2025 with 18 months for phased compliance. We need a clear consent notice, breach notification and a way to handle access and erasure requests.
- **GST:** sales to customers abroad are zero-rated exports of services with a Letter of Undertaking. Sales to Indian users carry 18%.

---

## 7. Where Textcrew stands today

| Area | Status |
|---|---|
| **Telegram:** linking, messages, replies | Built and tested live |
| **Claude Code on the user's Claude plan** | Built and tested live |
| **GitHub and Gmail actions** (pull request and email from one Telegram message) | Built and tested live |
| **Server:** deploy from GitHub `main`, sandboxing, network filter | Built and tested live on the AWS test server |
| **Approvals, reminders, automations, credits, coupons, waitlist** | Built; automated tests only |
| **User's own API key with Hermes** | Built; automated tests only. Never run on the server |
| **Git gateway** (real clone, branch, push) | Built and deployed; no real run yet |
| **Polar payments** | Code built; no Polar account, products or webhook yet |
| **WhatsApp and iMessage channels** | Code built; not launchable (section 6) |
| **Voice notes** | Code built; needs a speech-to-text key on the server |
| **Simple-chat routing** (no container for small talk) | Code built; needs a router key on the server |
| **Web app** (sign-up, link a chat, connect apps, billing) | Not built into a working product. Folders exist next to this repo; their state was not reviewed for this document |
| **The crew** (Scout, Patch) | Not built |
| **Browser or computer use** | Not built |
| **Our own Google OAuth app** | Not started |
| **Privacy policy and terms** | Not written |

Known bugs and gaps that affect a launch: app connections stay "pending" without the web app, the server is in `platform` AI mode with no model key, the nightly backup is unproven and stays on the same disk, and there is no alerting.

---

## 8. Positioning: who it is for and what to say

### 8.1 The audience

**Recommended: developers, indie founders and small-team operators who already pay for an AI model and use Telegram.** Four findings point there:

1. **Telegram is the only channel we can launch on,** and this audience is on it.
2. **The MVP requires the user's own AI.** Only people who already have an API key or a Claude plan can start in minutes.
3. **Coding from chat is the open gap.** No hosted text assistant found markets it, and we have already done it once end to end.
4. **The general "inbox and calendar" consumer is taken.** Funded iMessage-first products and the big labs are there, with the AI included and a free Muse inside WhatsApp in the US.

The alternative, a mass-market assistant on WhatsApp for India, is blocked twice: by Meta's rule and by the bring-your-own-AI requirement.

### 8.2 The message

- **One line:** "Text your crew on Telegram. It works in your apps, ships the small stuff, and asks before anything risky."
- **Why us, in three points:**
  1. **You can text it.** The big labs' agents live in their own apps.
  2. **It ships code.** Tell it on Telegram; get a pull request. Patch writes it and a second pass reviews it.
  3. **You bring your own AI, so you see the cost.** Our plan is $0, $12 or $30. Your model usage stays on your own key or plan.
- **Available everywhere Telegram is,** including India and Europe, where Dots, Spark and Muse are not.

### 8.3 What not to claim

- **Not "on WhatsApp"** and not "on iMessage" at launch.
- **Not "cheaper than Poke"** as a blanket claim. It is only true for users who already pay for AI.
- **Not "25 apps"** until each one has been tested.
- **Not six specialists.** Three crew members that work beat seven names.
- **No Anthropic or OpenAI logos.** Plain text only: "runs Claude Code".
- **Not "does anything on the web".** We have no browser control.

---

## 9. The MVP

### 9.1 What it does at launch

| # | Feature | Why it is in | Status |
|---|---|---|---|
| 1 | **Telegram bot** with text, files and buttons | The launch channel | Live-tested |
| 2 | **Web app:** sign up, link Telegram, connect apps, add your AI, see activity, pay | Nothing else works without it | To build |
| 3 | **Bring your own AI:** API key (main path), Claude plan (beta) | Section 6.5 | Claude plan live-tested; API key path needs a live test |
| 4 | **Apps:** Gmail, Google Calendar, GitHub, Notion, Slack, Linear or Todoist | The top jobs in section 5 | Gmail and GitHub live-tested; the rest need a test each |
| 5 | **Approvals** before sending, deleting or paying | Expected by every user | Built; needs a live test |
| 6 | **Reminders and schedules** | Third most-used job | Built; needs a live test |
| 7 | **Morning brief** as a ready-made schedule | Fourth most-used job, and it makes the agent feel proactive | A preset to add |
| 8 | **Coding from chat (Patch):** clone, branch, change, pull request, with a review pass | Our clearest difference | Git gateway deployed; crew to build |
| 9 | **Research (Scout):** search the web, read pages, answer with links | Fifth most-used job | To build (search and read only) |
| 10 | **Memory** of preferences and projects | Expected | In the engines; untested by us |
| 11 | **Clear cost:** credits shown per job, pause at zero | The top complaint about competitors | Ledger built; needs showing in chat and the web app |
| 12 | **Plans and payment** through Polar on the web | Revenue | Code built; account to set up |

### 9.2 What is left out, and why

| Left out | Why |
|---|---|
| WhatsApp | Not allowed (6.1). Revisit for EEA users |
| iMessage, SMS | No safe route (6.3, 6.4). iMessage later as a labelled beta |
| Phone calls | Not built, and costly |
| Browser and computer use | Needs a browser in each container and wider web access, which is a security design of its own |
| Echo, Pitch, Tock and Byte as separate agents | The same model with a different prompt; no evidence users need them |
| Document search (RAG, vector database) | Apps already have search. Add when users upload files |
| Team and business plans | After single users work |
| Platform-paid AI | Needs a model key and margin control. The code stays for later |

### 9.3 Pricing

Keep $0 / $12 / $30 with credits. Two things to fix in how it is explained:

- **Say what a credit buys.** With your own AI, credits pay for the time your agent's computer is awake (1 credit per 10 minutes) and paid tools. They do not pay for the model. The landing page currently reads as if credits cover everything.
- **Show the total honestly.** For example: "Pro is $12. Your AI usage is billed by your own provider."

### 9.4 Changes to the landing page

| Now | Change to |
|---|---|
| "Send one message on WhatsApp, Telegram or iMessage" | "Send one message on Telegram." List other channels as "coming where the platforms allow it" |
| "Tex + 6 specialists on the way" | "Tex, Scout and Patch" |
| "Approximately 25 apps at launch" | The tested apps, by name |
| Channels list: WhatsApp, Telegram, iMessage, web app | Telegram and web app |
| "Requires user AI key (Anthropic, OpenAI, or OpenRouter)" | Keep, and add "or your Claude plan (beta)" in plain text |
| Credits copy | The explanation in 9.3 |

Add: a privacy policy and terms page (Telegram, Google and Polar all expect them).

---

## 10. Launch checklist

In order. Items 1 to 3 are decisions for the founder.

1. **Decide the audience and channel:** Telegram-first for developers and founders (section 8), or something else.
2. **Decide the AI path:** API key as the default with the Claude plan as beta, and switch the server to `own_only` so users without their own AI are told to connect one.
3. **Decide the crew names:** the landing page lists Byte for coding and Patch for review; this document uses Patch for coding as the founder proposed.
4. **Build the web app** (item 2 in 9.1).
5. **Set up Polar:** account, products, discount, webhook. Keep purchase links out of the bot.
6. **Fix the known gaps:** pending app connections, a live git gateway test, off-server backups, alerts, block `/mcp` and `/git` from the public internet.
7. **Live-test what is only unit-tested:** approvals, reminders, schedules, the API key path, each launch app.
8. **Build Scout and Patch,** and the morning-brief preset.
9. **Anthropic:** accept the Commercial Terms, ask sales for written confirmation of our setup, and let Claude Code accept the user's own API key if the answer requires it.
10. **Google:** start our own OAuth app verification and security assessment; stay under 100 Gmail users on Composio's app until it passes.
11. **Write the privacy policy and terms,** covering the DPDP consent, erasure and breach duties.
12. **Update the landing page** (9.4).
13. **Closed beta with 20 to 50 waitlist users.** Measure: how many link Telegram and finish a first job, jobs per user per week, failed jobs, approval response time, and our cost per user.
14. **Later:** WhatsApp for EEA users, iMessage beta, browser use, more crew.

---

## 11. Could not verify

- **Prices:** ChatGPT Pro and Business Premium, and SuperGrok tiers, came from blogs only. Notis and Zapia do not publish prices.
- **Muse in WhatsApp:** Meta's post says it works in WhatsApp but its rollout line lists only the apps and muse.ai.
- **Dots by SMS:** OpenAI's help page and launch post disagree.
- **Grok Bot:** the plugin count (220) and model come from one press source; Android availability and country list are unclear.
- **How Pally, Arlo, Catch, Martin and Notis offer WhatsApp** under Meta's rule.
- **Whether Meta complied with the EU order,** and Brazil's current status.
- **Anthropic:** when the "offer Claude Code in their products" section was added, and whether a messaging gateway falls inside it.
- **OpenAI:** its terms pages blocked automated reading; whether a ChatGPT subscription may be used in third-party hosting is unknown.
- **Google:** the real cost and tier of the security assessment for our scopes.
- **US SMS registration** for an Indian company.
- **Competitor complaints** are from a small number of public reviews, and several comparison blogs are written by competitors.
- **Reddit:** no complaint threads were found, so the complaint list leans on app stores, Product Hunt and Trustpilot.

---

## 12. Sources

**Read directly for this document (2026-10-02)**

- Meta Terms for WhatsApp Business Platform, section 4.7: https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform
- Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- Textcrew landing page: https://textcrew.in

**Dots**

- https://openai.com/index/introducing-dots/
- https://help.openai.com/en/articles/20001530-getting-started-with-your-dot
- https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/
- https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/
- https://www.platformer.news/openai-dots-agents-devday-2026/
- https://www.eesel.ai/blog/openai-dots-review (blog)

**Grok Bot and Grok in Telegram**

- https://x.ai/news/introducing-grok-bot
- https://x.ai/news/team-bots
- https://docs.x.ai/grok-bot/overview
- https://docs.x.ai/grok-bot/security
- https://cursor.com/help/grok-bot/plans
- https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/
- https://techcrunch.com/2025/05/28/xai-to-pay-300m-in-telegram-integrate-grok-into-app

**Muse and Manus**

- https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
- https://www.meta.com/help/subscriptions/1021145227643680/
- https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/
- https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/
- https://fortune.com/2026/09/22/metas-muse-ai-is-exploding-in-popularity-and-drawing-heated-backlash/
- https://techcrunch.com/2026/04/27/china-vetoes-metas-2b-manus-deal-after-months-long-probe/
- https://siliconangle.com/2026/02/16/manus-launches-personal-ai-agents-telegram-messaging-apps-come/

**Other big labs**

- Anthropic: https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile · https://claude.com/blog/cowork-web-mobile · https://code.claude.com/docs/en/channels · https://code.claude.com/docs/en/routines · https://claude.com/pricing
- Google: https://support.google.com/gemini/answer/17094507 · https://techcrunch.com/2026/05/19/google-introduces-gemini-spark-a-24-7-agentic-assistant-with-gmail-integration/
- Microsoft: https://support.microsoft.com/en-us/microsoft-365-copilot/learning/changes-microsoft-copilot-app · https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/
- Perplexity: https://venturebeat.com/technology/perplexity-takes-its-computer-ai-agent-into-the-enterprise-taking-aim-at · https://www.datacamp.com/tutorial/perplexity-computer (blog)
- Amazon: https://www.aboutamazon.com/news/devices/alexa-plus-international-launch · https://techcrunch.com/2026/02/04/alexa-amazons-ai-assistant-is-now-available-to-everyone-in-the-u-s/

**Assistants you text**

- Poke: https://poke.com/pricing · https://poke.com/docs · https://techcrunch.com/2026/04/08/poke-makes-ai-agents-as-easy-as-sending-a-text/ · https://techcrunch.com/2026/07/24/why-cognition-bought-poke-ai-personality-is-becoming-a-competitive-advantage/ · https://www.producthunt.com/products/poke-by-interaction-co/reviews
- Pally: https://pally.com/
- Martin: https://www.trymartin.com/pricing · https://apps.apple.com/us/app/martin-personal-assistant/id6453473083
- Tomo: https://www.trustpilot.com/review/tomo.ai
- Catch: https://www.catchagent.ai/
- Arlo: https://www.arlo.sh/pricing
- Lindy: https://www.lindy.ai/pricing · https://www.trustpilot.com/review/lindy.ai
- Carly: https://www.usecarly.com/pricing/
- Zo Computer: https://www.zo.computer/pricing
- Notis: https://www.notis.ai/pricing
- OpenClaw: https://openclaw.ai/
- Puch AI: https://www.digit.in/features/general/what-is-puch-ai-the-whatsapp-assistant-sponsoring-messis-india-tour.html
- Zapia: https://zapia.com/

**Platform rules**

- WhatsApp: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers · https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/ · https://techcrunch.com/2026/03/05/meta-will-allow-rival-ai-chatbots-on-whatsapp-in-europe-but-for-a-fee/ · https://europeansting.com/2026/06/10/commission-imposes-interim-measures-on-meta-to-preserve-free-access-to-whatsapp-for-rival-ai-assistants/
- Telegram: https://telegram.org/tos/bot-developers · https://core.telegram.org/bots/payments-stars · https://core.telegram.org/bots/faq
- iMessage: https://register.apple.com/resources/messages/messaging-documentation/policies · https://techcrunch.com/2026/06/04/apple-approves-poke-as-the-first-ai-agent-on-its-messages-for-business-platform/ · https://www.lindy.ai/blog/imessage-api-three-rewrites-one-apple-ban-and-what-actually-works
- SMS: https://www.twilio.com/docs/messaging/compliance/a2p-10dlc · https://www.twilio.com/en-us/guidelines/in/sms
- Anthropic: https://www.anthropic.com/legal/consumer-terms · https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan · https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/
- Google: https://developers.google.com/workspace/gmail/api/auth/scopes · https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification · https://support.google.com/cloud/answer/7454865
- Composio: https://docs.composio.dev/docs/tools-direct/authenticating-tools · https://docs.composio.dev/docs/white-labeling-authentication
- Polar: https://polar.sh/docs/merchant-of-record/fees · https://polar.sh/docs/merchant-of-record/supported-countries · https://polar.sh/docs/merchant-of-record/acceptable-use
- Open source: https://github.com/advisories/GHSA-pgp4-xr4j-h5cg · https://thehackernews.com/2026/02/clawjacked-flaw-lets-malicious-sites.html
- India: https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf
