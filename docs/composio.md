# Composio: what it is, how Textcrew uses it, what it costs

This file explains Composio from the very beginning. What it says about our own server was checked in our code. What it says about Composio (prices, screens, limits) was read on Composio's website on 9 October 2026. Prices and screens change. Where something could not be confirmed, it says "not confirmed".

No secret values are written here.

**In short**

| | |
|---|---|
| **What Composio is** | An outside service. It keeps each user's permission for their apps, and it runs actions in those apps when our server asks |
| **Why 23 apps show "Not available yet"** | Each app needs a small setup at Composio, made once by us. Only Gmail and GitHub have one. Nothing is broken |
| **How to switch on one more app** | About ten minutes, no code change. Section 8 |
| **What it costs us** | $0 on Composio's free plan for a small beta. $29 a month on the next plan. Section 9 |
| **What users pay us** | 1 credit for an action that changes something. Reading is free |

## Contents

1. [The problem, and what Composio is](#1-the-problem-and-what-composio-is)
2. [Who talks to whom](#2-who-talks-to-whom)
3. [The three things Composio has](#3-the-three-things-composio-has)
4. [What happens when a user clicks Connect](#4-what-happens-when-a-user-clicks-connect)
5. [What happens when the user asks for something in an app](#5-what-happens-when-the-user-asks-for-something-in-an-app)
6. [What our server adds on top of Composio](#6-what-our-server-adds-on-top-of-composio)
7. [Triggers: "when an email arrives, tell me"](#7-triggers-when-an-email-arrives-tell-me)
8. [How to make a new app connectable](#8-how-to-make-a-new-app-connectable)
9. [What it costs](#9-what-it-costs)
10. [What can go wrong](#10-what-can-go-wrong)
11. [Words used](#11-words-used)
12. [Sources](#12-sources)

---

## 1. The problem, and what Composio is

Rahul texts Tex: "send an email to Priya". To do that, something must hold Rahul's permission to use his Gmail. That is harder than it sounds:

- **Gmail never gives out the password.** Google shows Rahul a screen: "Allow this app to read and send your email?" He clicks **Allow**. Google then gives the app a **token**: a long secret string that works like a key to Rahul's Gmail. This way of asking is called **OAuth**.
- **The token must be kept safe and renewed,** for every user.
- **Then the app must talk to Gmail in Gmail's own way.** That is Gmail's **API**: the list of requests a program may send to Gmail, such as "send this email".
- **Every app is different.** Google Calendar, Slack, GitHub and Notion each have their own sign-in rules and their own API.

Building that ourselves for 25 apps would take months. Composio already built it, for more than 1,500 apps.

**Composio does two jobs for us:**

1. It keeps each user's token for each app, and renews it.
2. It runs an action in the app when our server asks.

**Example.** Rahul connects Gmail once. Composio stores his token. Later our server tells Composio: "send this email as Rahul, to priya@example.com". Composio sends it through Gmail. Our server never sees Rahul's password or his token.

---

## 2. Who talks to whom

```text
 Rahul                       Tex, the agent
 (Telegram or the web app)   (in Rahul's own container)
        |                            |
        | A                          | B
        |                            |
      +--------------------------------+
      |           Our server           |
      +--------------------------------+
                      |
                      | C
                      |
                +-----------+     D     +---------+
                | Composio  |-----------|  Gmail  |
                +-----------+           +---------+
```

| Line | What goes over it |
|---|---|
| **A** | Rahul's message goes in. Tex's reply comes out |
| **B** | Our server gives Tex the message. Tex asks our server to run an app action and gets the result |
| **C** | Our server tells Composio "run this action as Rahul" and gets the result. Composio's key is used here and nowhere else |
| **D** | Composio sends the real request to Gmail, with Rahul's token |

There is no line from Tex to Composio, and none from Tex to Gmail. Tex can reach an app only through our server. A container is the closed box on our server where one user's agent runs.

---

## 3. The three things Composio has

| What it is | Composio's word | Example with Gmail | Who makes it |
|---|---|---|---|
| **The setup for one app** | Auth config | "This is how sign-in to Gmail works for Textcrew." Its id starts with `ac_` | We do, once per app |
| **One user's connection** | Connected account | Rahul's permission for his own Gmail. Composio keeps his token here | Rahul, when he clicks Connect |
| **An action** | Tool | "Send email", "list emails". Each has a name like `GMAIL_SEND_EMAIL` | Composio. They are ready to use |

One setup serves all users. Rahul and Priya each have their own connection, and both use the same Gmail setup.

**Why the web app says "Not available yet".** The first thing is missing: the setup.

1. Our code has a fixed list of 25 apps.
2. For each app, our server looks in one setting, `COMPOSIO_AUTH_CONFIGS`, for that app's setup id.
3. Today the setting holds two ids: Gmail and GitHub. For the other 23 apps the web app shows "Not available yet" and no Connect button.

Nothing is broken. Nobody has made those 23 setups yet. Section 8 shows how to make one.

---

## 4. What happens when a user clicks Connect

Example: Rahul connects Gmail.

1. Rahul clicks **Connect** on Gmail in the web app.
2. Our server checks his plan. Gmail is on the Free list, so it goes on.
3. Our server asks Composio for a connect link. It gives Composio the Gmail setup id and our own id for Rahul.
4. Our server saves the connection as "pending" and gives the link to the browser.
5. The browser opens Composio's connect page, then Google's own sign-in page. Rahul signs in and clicks **Allow**.
6. Google gives the token to Composio. Composio keeps it.
7. The browser goes back to the web app.
8. Our server learns that the connection is active. There are three ways, and the first one wins:
   - Composio sends our server a **webhook**: a message that another service sends to our server when something happens.
   - The web app shows the app list, and our server asks Composio.
   - The worker asks Composio by itself, six times over about 16 minutes.
9. Gmail shows as connected.

Our database keeps only Composio's id for the connection, its status and a label. The token stays at Composio.

---

## 5. What happens when the user asks for something in an app

### A request that only reads

Rahul texts "what is on my calendar tomorrow". Say Google Calendar is connected.

1. The message reaches our server, then Tex in Rahul's container.
2. Tex asks our server which actions it may use. Our server asks Composio, only for the apps that Rahul has connected and that his plan allows.
3. Tex picks the action that lists calendar events and asks our server to run it.
4. The action only reads, so it needs no OK from Rahul.
5. Our server tells Composio: run this action as Rahul. The user id is always the one that belongs to the container. Tex cannot name another user.
6. Composio asks Google Calendar with Rahul's token and returns the events.
7. Tex writes the answer. The action costs Rahul nothing.

### A request that changes something

Rahul texts "send an email to Priya with the notes".

1. Tex picks the action "send email". Our server marks it as risky: it does not run without Rahul's OK.
2. Tex asks for approval and ends its turn. Rahul gets "Approval needed: Send the notes to priya@example.com", with **Approve** and **Reject** buttons.
3. Rahul taps **Approve**.
4. Tex wakes up and asks our server to run the action, with the approval.
5. Our server checks that Rahul has credits, and that the approval is his, unused, and for exactly this action and these details.
6. Our server tells Composio to send the email as Rahul. Composio sends it through Gmail.
7. Rahul is charged 1 credit.

If Composio or Gmail fails at step 6, nothing is charged and the same approval can be used again.

---

## 6. What our server adds on top of Composio

Composio runs any action our server asks for. The rules are ours.

| What we add | What it does | Why |
|---|---|---|
| **Approval** | An action that sends, deletes, pays or changes something that exists runs only after the user says yes. Creating a calendar event needs a yes too. One yes works once, for the exact details shown | An agent can misunderstand. A sent email cannot be taken back |
| **Credits** | A successful action that changes something costs 1 credit. Reading is free. At zero credits a changing action is refused, and reading still works | This is how users pay us |
| **Plan limits** | Free may connect 10 of the 25 apps. Pro and Max may connect all 25 | A reason to upgrade |
| **The key stays on our server** | Composio's key is a setting of our server only. No container ever gets it | A container runs code and reads text written by strangers. With that key, one tricked agent could open every user's apps |

---

## 7. Triggers: "when an email arrives, tell me"

A **trigger** is Composio watching one app for one user, and telling our server when something happens there.

Example: Rahul texts "when an email arrives, tell me on Telegram".

1. Tex asks our server to create an automation of the kind "on an app event". Gmail must be connected.
2. Our server asks Composio to start a trigger on Rahul's Gmail. It saves the automation with the trigger's id.
3. An email arrives. Composio looks at Gmail on a schedule. With the shared sign-in we use, the news can be up to about 15 minutes late.
4. Composio sends a webhook to our server, at `https://api.textcrew.in/webhooks/composio`.
5. Our server checks that the webhook really comes from Composio, with the setting `COMPOSIO_WEBHOOK_SECRET`. It saves the event and adds a job.
6. The worker finds the automation by the trigger's id, and checks that it is Rahul's and is switched on.
7. Tex gets a normal turn, with the saved instruction and the email's data. Tex tells Rahul on Telegram.

Good to know:

- **Every event is a full turn.** It costs Rahul credits like a normal message does.
- **Pull-request review uses the same path:** a trigger on one GitHub repo.
- **Not proven yet.** The code and its tests exist. On the test server, no webhook from Composio has been seen arriving. The webhook address in Composio's dashboard must be `https://api.textcrew.in/webhooks/composio`. You set it under **Platform → Settings → Webhooks**.

---

## 8. How to make a new app connectable

Example: Google Calendar. It takes about ten minutes. There is no code change and no deploy.

### Part A. In Composio's dashboard

1. Sign in at `https://dashboard.composio.dev`. Choose **Platform**, then the project whose key is on our server. A setup made in another project will not work.
2. Open **Auth Configs**.
3. Click **Create Auth Config**.
4. Choose the toolkit **Google Calendar**. "Toolkit" is Composio's word for an app.
5. Choose the authentication method **OAuth2**.
6. Keep Composio's managed authentication. Do not tick **Use your own developer credentials**. Leave the scopes as they are. A scope is one permission the user is asked for.
7. Click **Create Auth Configuration**.
8. Copy the id of the new setup. It starts with `ac_`.

These names are from Composio's help pages, which do not all use the same words. The dashboard may look a little different.

### Part B. On our server

9. Log in to the server:
   ```sh
   ssh -i ~/.ssh/textcrew_aws ubuntu@3.111.132.222
   ```
10. Open the file `/opt/textcrew/beckend/.env` and find the line that starts with `COMPOSIO_AUTH_CONFIGS=`. Add Google Calendar at the end, inside the brackets:
    ```text
    before:  COMPOSIO_AUTH_CONFIGS={"gmail":"ac_...","github":"ac_..."}
    after:   COMPOSIO_AUTH_CONFIGS={"gmail":"ac_...","github":"ac_...","googlecalendar":"ac_the_new_id"}
    ```
    Keep it on one line, with the double quotes and the commas. If the line is damaged, every app shows "Not available yet", Gmail and GitHub too.
11. Restart the api and the worker, so that they read the new setting:
    ```sh
    cd /opt/textcrew && ./dc --profile app up -d --force-recreate --no-deps api worker
    ```
12. Open the web app and go to **Apps**. Google Calendar now has a **Connect** button. Click it, sign in with Google and click **Allow**.
13. Text Tex: "what is on my calendar tomorrow".

**The name to type for each app.** The Free ten: `gmail`, `googlecalendar`, `googledrive`, `googledocs`, `googlesheets`, `notion`, `todoist`, `slack`, `github`, `exa`. The other 15: `outlook`, `microsoft_teams`, `onedrive`, `dropbox`, `trello`, `asana`, `linear`, `jira`, `clickup`, `airtable`, `hubspot`, `salesforce`, `calendly`, `zoom`, `linkedin`.

**Which apps work this way.** Composio's list shows a managed sign-in for 24 of our 25 apps. The exception is Exa Search. It works with an API key and has no sign-in screen, so its setup is different. It is not covered here.

**Without the dashboard.** Part A can also be done through Composio's API, with the key our server already uses, so Claude can do it for you. The call is `POST https://backend.composio.dev/api/v3.1/auth_configs`, with the app's name and the type `use_composio_managed_auth`. It works if the key was made with full access, which is the default.

### "Composio managed", or our own app at Google

In step 6 there are two choices.

| | Composio managed (what we use for Gmail) | Our own app |
|---|---|---|
| **Who registered the app at Google** | Composio. All Composio customers share it | We do, in Google Cloud. Then we give its client id and secret to Composio |
| **Name on Google's "Allow" screen** | Composio | Textcrew |
| **Google's "unverified app" warning** | Google's review is Composio's job. Do not add scopes, or Google can block the sign-in | Shown until Google has verified our app. Until then Google stops at 100 new users |
| **Free amount at Composio, a month** | 20,000 actions and 10,000 trigger events | 100,000 actions and 50,000 trigger events |
| **Email triggers** | Checked every 15 minutes at the fastest | Can be faster |

Whether our GitHub setup is Composio managed too is not confirmed. It most likely is.

**When we would need our own app:**

- Users must see "Textcrew", not "Composio", when they allow access.
- We pass 20,000 actions or 10,000 trigger events a month.
- "When an email arrives" must be faster than 15 minutes.
- Code work through git on GitHub (section 10).

**Before switching:** Google must review an app that reads Gmail before it can pass 100 users, so that review must start early. Users who connected through the shared app stay on it until they connect again.

---

## 9. What it costs

### 9.1 What Composio charges us

Read on Composio's pricing page on 9 October 2026. Prices change.

| | Hobby | Pro | Enterprise |
|---|---|---|---|
| **Price** | $0 | $29 a month | Custom |
| **Card needed** | No. The page says "No credit card required" | Not stated. Whether a RuPay card is accepted is not confirmed | Not stated |
| **Actions** | 100,000 a month free | The same free amount, then $0.0003 each | Custom |
| **Trigger events** | 50,000 a month free | The same free amount, then $0.003 each | Custom |
| **Users' connections** | Unlimited, free | Unlimited, free | Custom |
| **Apps** | 1,500+ | 1,500+ | 1,500+ |
| **Support** | "Portal" | "Portal + Email + Slack at $1K" | Dedicated |
| **At the limit** | Use stops until next month. No bill | Use goes on and the extra is billed. A spending cap can be set | Custom |
| **Also included** | | $29 of usage credit each month. Unused credit is lost | |

**What counts as one unit:**

| Unit | Composio's word | What counts as one |
|---|---|---|
| Action | Tool call | One action run in an app. Reading counts too |
| Trigger event | Trigger event | One event delivered to our webhook, for example one new email |
| Connection | Connected account | One user's connection to one app |

Whether a failed action counts is not stated.

**Three rules on the same page that matter for us:**

1. **The shared sign-in has a smaller free amount.** With Composio managed apps, only 20,000 of the 100,000 free actions and 10,000 of the 50,000 free trigger events can be used. After that an action costs $0.0005 and a trigger event $0.005. The first 1,000 connections are free.
2. **"Direct execution".** Composio now wants actions to run inside what it calls a Session. Our server runs them the older, direct way. For that way the page lists 10,000 a month free on Hobby, and $0.0001 extra per action on Pro. We read this as: on Hobby our actions stop at 10,000 a month. Not confirmed with Composio.
3. **Old accounts keep old prices.** An account made before 15 August 2026 keeps its earlier prices until 31 December 2026. When our account was made is not confirmed.

### 9.2 What we charge our users

| Thing | Price to the user |
|---|---|
| An action that changes something: send, create, update, delete | 1 credit, only when it succeeds |
| An action that only reads: get, list, search | Free |
| A failed or refused action | Free |
| Connecting an app | Free |
| A trigger | No price of its own. Each event starts a turn, and a turn costs credits like a message |

- 1 credit is $0.01 of price. Every user pays it, also a user who brings their own AI.
- Free may connect 10 apps: Gmail, Google Calendar, Drive, Docs, Sheets, Notion, Todoist, Slack, GitHub and Exa Search. Pro and Max may connect all 25.
- **The two sides do not match.** Composio counts every action, also reading. We charge the user only for changes.

### 9.3 One worked example

A beta month. **Every number in this list is an assumption:**

- 20 users, and a month of 30 days.
- Each user's agent runs 20 app actions a day: 15 that read and 5 that change something.
- 5 of the 20 users have one "when an email arrives" automation, and each of them gets 40 emails a day.
- Each user connects 2 apps.
- All apps use Composio's shared sign-in, and our server runs actions the direct way, as today.

| Unit | Arithmetic | In the month | Free on Hobby, shared sign-in | Enough? |
|---|---|---|---|---|
| Actions | 20 users × 20 a day × 30 days | 12,000 | 20,000 | Yes |
| The same actions, counted as "direct" | All of them | 12,000 | 10,000 | No: 2,000 over |
| Trigger events | 5 users × 40 emails × 30 days | 6,000 | 10,000 | Yes |
| Connections | 20 users × 2 apps | 40 | 1,000 | Yes |

**Which plan, and what it costs us:**

- **Hobby, $0,** covers three of the four lines. If we read the "direct" rule right, actions would stop at 10,000, around day 25.
- **Pro, $29 a month,** covers everything. The 2,000 extra actions cost 2,000 × $0.0001 = $0.20. As we read the page, that comes out of the $29 of credit. So the month costs us **$29**.
- **Below 10,000 actions a month, Hobby at $0 is enough.** That is 20 users with 16 actions a day each.

**What the users pay us for these actions:** 20 users × 5 changes × 30 days = 3,000 credits. That is $30 of price, when the credits were bought and not given free.

**What grows fastest later:** trigger events on the shared sign-in. With 100 users and the same use, that is 30,000 events a month. 20,000 of them are over the free amount: 20,000 × $0.005 = $100 a month. With our own Google app, the 50,000 free events would cover all of them.

---

## 10. What can go wrong

| What happened | What the user sees | What to do |
|---|---|---|
| **The app has no setup on our server** | "Not available yet" in the web app, and no Connect button | Section 8 |
| **The connection expired.** The user changed their password or removed our access at Google | The web app shows "Expired" and a **Reconnect** button. Tex says the app is not connected, or reports an error from the app | The user clicks Reconnect |
| **Composio or the app is down** | Tex says the app is unavailable right now. Nothing is charged. An approval already given still works later | Wait |
| **Composio's free limit is reached** | Actions fail. Tex reports an error or says the app is unavailable | Wait for next month, or move to Pro |
| **Composio's webhook does not reach our server** | "When an email arrives" never fires. Pull-request review never starts | Set the webhook address (section 7) |
| **Composio hides the GitHub token** | Git answers "The GitHub connection can't be used for git". Byte cannot clone or push, and Patch cannot read the code for a review. GitHub actions through Composio still work | See below |

**The hidden token, in more words.** Our git gateway lets the agent use normal git on the user's GitHub. For that, our server asks Composio for the user's GitHub token. Composio hides ("masks") tokens in its answers.

- Our design counted on one Composio project setting, "mask connected account secrets", being switched off.
- Composio's change note of 22 April 2026 says that for a connection made through its shared app, the token is always hidden, whatever that setting says.
- So with the shared GitHub sign-in, the setting does not help. Git through our gateway, and pull-request review with it, would need our own GitHub app at Composio.
- Composio's newer help pages say tokens are hidden for own apps too. So it is not confirmed that this can work at all. It has never run for real on the test server.

---

## 11. Words used

| Word | What it means |
|---|---|
| **API** | The list of requests a program may send to a service, such as "send this email" |
| **Token** | A long secret string that works like a key to one user's account in one app |
| **OAuth, OAuth2** | The usual way a user gives an app permission without giving the password: the screen with the Allow button |
| **Scope** | One permission the user is asked for, such as "read your calendar" |
| **Webhook** | A message that another service sends to our server when something happens |
| **Toolkit** | Composio's word for an app, such as Gmail |
| **Auth config** | Composio's word for the setup of one app. We make it once. Its id starts with `ac_` |
| **Connected account** | Composio's word for one user's connection to one app |
| **Tool, tool call** | Composio's words for an action, and for running it once |
| **Trigger, trigger event** | Composio watching an app for a user, and one thing it reports |
| **Composio managed** | Sign-in through Composio's own shared app at Google, GitHub and others |
| **Session, direct execution** | Composio's new way and old way of running actions. We use the old one |

---

## 12. Sources

All read on 9 October 2026.

- Composio's prices: https://composio.dev/pricing (the same page as plain text: https://composio.dev/pricing.md)
- Making a setup in the dashboard: https://docs.composio.dev/kb/guide/dashboard-auth-configs-navigation and https://docs.composio.dev/docs/tools-direct/authenticating-tools
- Composio managed or our own app: https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app
- Which apps have a managed sign-in: https://docs.composio.dev/toolkits/managed-auth
- Making a setup through the API: https://docs.composio.dev/docs/authentication/programmatic-auth-configs and https://docs.composio.dev/reference/api-reference/auth-configs/postAuthConfigs (what a key may do: https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions)
- Our own Google app, step by step: https://composio.dev/auth/googleapps
- Triggers and webhooks: https://docs.composio.dev/docs/triggers and https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events
- Sessions and direct execution: https://docs.composio.dev/docs/sessions-vs-direct-execution
- Hidden tokens: https://docs.composio.dev/docs/changelog/2026/04/22 and https://docs.composio.dev/docs/auth-configuration/connected-accounts
- Where the dashboard's settings are: https://docs.composio.dev/kb/guide/dashboard-project-settings-navigation
- Google's "unverified app" screen and the 100-user limit: https://support.google.com/cloud/answer/7454865
