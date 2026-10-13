# Composio: what it is, how Textcrew uses it, what it costs

This file explains Composio from the very beginning. What it says about our own server was checked in our code. What it says about Composio (prices, screens, limits) was read on Composio's website on 9 October 2026. Section 9, and the new parts of sections 4 and 8, were read in Composio's own help pages and its code library on 13 October 2026 (section 13). Prices and screens change. Where something could not be confirmed, it says "not confirmed".

No secret values are written here.

**In short**

| | |
|---|---|
| **What Composio is** | An outside service. It keeps each user's permission for their apps, and it runs actions in those apps when our server asks |
| **Why 23 apps show "Not available yet"** | Each app needs a small setup at Composio. Only Gmail and GitHub have one. Nothing is broken |
| **How to switch on more apps** | One line in the server's settings, `COMPOSIO_MANAGED_APPS=all`, and a restart. The server then makes each app's setup itself. Section 8 |
| **Composio's name on the way to an app** | Our own connect screen now comes first. The rest only you can do: our logo on Composio's page (5 minutes), our own GitHub sign-in app (about 20 minutes), our own Google sign-in app (weeks of review by Google). Section 9 |
| **What it costs us** | $0 on Composio's free plan for a small beta. $29 a month on the next plan. Section 10 |
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
9. [Hiding Composio's name from users](#9-hiding-composios-name-from-users)
10. [What it costs](#10-what-it-costs)
11. [What can go wrong](#11-what-can-go-wrong)
12. [Words used](#12-words-used)
13. [Sources](#13-sources)

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
2. For each app, our server looks for that app's setup id, in this order:
   - the setting `COMPOSIO_AUTH_CONFIGS`, where we name a setup ourselves;
   - a list of setups the server made itself earlier, kept in its own database table;
   - the setting `COMPOSIO_MANAGED_APPS`. An app named there, or every app when it says `all`, gets its setup made by the server on its first connect.
3. `COMPOSIO_AUTH_CONFIGS` holds two ids, Gmail and GitHub. Since 13 October `COMPOSIO_MANAGED_APPS` is `all` on the test server, so every app but Exa Search has a Connect button, and the server makes each app's setup on its first connect. It made Google Calendar's that day.

Without that setting, an app with no setup shows "Not available yet" and no Connect button. Nothing is broken then: nobody has made its setup yet. Section 8 shows how to switch them on.

---

## 4. What happens when a user clicks Connect

Example: Rahul connects Gmail.

1. Rahul clicks **Connect** on Gmail in the web app.
2. The web app shows its own connect screen, with no Composio in it: Gmail's icon next to Tex, "What Tex can do with Gmail", three rules, and a **Continue to Google** button. The rules: Tex asks first before it sends, deletes or changes something that's already there; reading is free and each change costs 1 credit; Rahul signs in on Google's own page. **Cancel** changes nothing.
3. Rahul clicks **Continue to Google**. Our server checks his plan. Gmail is on the Free list, so it goes on.
4. Our server finds Gmail's setup id (section 3), or makes the setup if it may.
5. Our server asks Composio for a link. It gives Composio the setup id, our own id for Rahul, and the web app's page to come back to. Which link depends on the setup:
   - **Composio's shared sign-in** (Gmail today): a link to Composio's connect page. That page comes first, then Google's.
   - **Our own sign-in app** (section 9): a link straight to Google's own page. Rahul sees no Composio page and no Composio address on the way.
6. Our server saves the connection as "pending" and gives the link to the browser.
7. Rahul signs in on Google's page and clicks **Allow**. With Composio's shared sign-in, Google's screen says that Composio wants access. With our own sign-in app, it says Textcrew.
8. Google gives the token to Composio. Composio keeps it.
9. The browser goes back to the web app. Composio adds `status=success` or `status=failed` to the address. The web app says "Gmail is connected", or "Gmail didn't connect" when Rahul stopped or Google refused. This message reads Composio's word in the address only. Our server may still have the connection as "pending" for a few seconds.
10. Our server learns that the connection is active. There are four ways, and the first one wins:
   - Composio sends our server a **webhook**: a message that another service sends to our server when something happens.
   - The web app shows the app list, and our server asks Composio.
   - Tex looks at Rahul's apps (`get_profile`, `list_app_actions`) or runs a Gmail action, and our server asks Composio first.
   - The worker asks Composio by itself, six times over about 16 minutes.
   Each time, our server asks Composio about that one connection, by its id.
11. Gmail shows as connected, and Tex can use it.

If Rahul asks Tex about Gmail before step 10 has happened, Tex says that Gmail is still connecting. If the sign-in never finished, Tex says to connect it again on the Apps page.

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

There are two ways. The quick way lets our server make the setups itself, for every app at once. The dashboard way makes one setup by hand, and is the one to use for our own sign-in app (section 9).

### The quick way: let the server make the setups

It takes five minutes, once, for all apps. There is no code change and no deploy.

1. Log in to the server:
   ```sh
   ssh -i ~/.ssh/textcrew_aws ubuntu@3.111.132.222
   ```
2. Open the file `/opt/textcrew/beckend/.env`. Add this line, or change it if it is there:
   ```text
   COMPOSIO_MANAGED_APPS=all
   ```
   To switch on only some apps, list their names instead, with commas and no spaces: `COMPOSIO_MANAGED_APPS=googlecalendar,googledrive,notion,slack`. The names are in the list at the end of this section.
3. Restart the api and the worker:
   ```sh
   cd /opt/textcrew && ./dc --profile app up -d --force-recreate --no-deps api worker
   ```
4. Open the web app and go to **Apps**. Every app except Exa Search now has a **Connect** button.
5. Connect one, for example Google Calendar. The first person to connect an app waits a second longer: the server makes the app's setup at Composio then, with Composio's shared sign-in. Composio's dashboard then shows a setup named "Textcrew Google Calendar". If the Composio project already had an enabled shared setup for that app, the server uses it and makes none.
6. Check it on the server, with the email you sign in with:
   ```sh
   cd /opt/textcrew && ./dc --profile app exec -T api node --import tsx scripts/dev-user.ts apps --email <your email>
   ```
   The line for Google Calendar must say `active` and "Composio: ACTIVE", and a line must say "agent sees googlecalendar: connected". Section 11 says what the other answers mean.

Good to know:

- **Plan limits still apply.** A Free user sees Upgrade on the 15 apps that are not on the Free list, and the server makes no setup for them.
- **The rules are the same as for Gmail.** Every app's actions go through the same approval and credit rules (section 6).
- **The Composio key must be allowed to make setups.** A key made with full access, the default, is. If it is not, the user sees "Google Calendar can't be connected right now" (section 11). Then make the setup the dashboard way.
- **These apps use Composio's shared sign-in,** so the provider's "Allow" screen names Composio. Section 9 says how to change that, app by app.
- **Taking an app off the setting does not hide it again** once its setup is made, because users' connections live on that setup. To hide one, ask Claude to remove its row from the table `composio_auth_configs`.
- **A setup named in `COMPOSIO_AUTH_CONFIGS` always wins** over one the server made.
- **Run for real once.** On 13 October the server made Google Calendar's setup itself, and the founder connected it. Tex then saw only GitHub; the fix is in section 11, "Connected, but Tex can't see it".

### The dashboard way

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

**Which apps work this way.** Composio's list shows a managed sign-in for 24 of our 25 apps. The exception is Exa Search. It works with an API key and has no sign-in screen, so its setup is different. It is not covered here, and the quick way leaves it out.

**Without the dashboard.** Part A is what the quick way does: our server calls Composio with the key it already has, and asks for a setup with Composio's shared sign-in (`use_composio_managed_auth`).

### "Composio managed", or our own app at Google

In step 6 there are two choices.

| | Composio managed (what we use for Gmail) | Our own app |
|---|---|---|
| **Who registered the app at Google** | Composio. All Composio customers share it | We do, in Google Cloud. Then we give its client id and secret to Composio |
| **Name on Google's "Allow" screen** | Composio | Textcrew |
| **Google's "unverified app" warning** | Google's review is Composio's job. Do not add scopes, or Google can block the sign-in | Shown until Google has verified our app. Until then Google stops at 100 new users |
| **Free amount at Composio, a month** | 20,000 actions and 10,000 trigger events | 100,000 actions and 50,000 trigger events |
| **Email triggers** | Checked every 15 minutes at the fastest | Can be faster |

Whether our GitHub setup is Composio managed too is not confirmed. It most likely is. The server can now tell you. Run this on the server, with your own user id:

```sh
cd /opt/textcrew && ./dc --profile app exec -T api node --import tsx scripts/dev-user.ts connect-app --user <your user id> --app github
```

The second line it prints says either "sign-in: Composio's connect page first, then the provider's" (Composio managed) or "sign-in: straight to the provider's page (our own sign-in app)". The link it prints can be left unopened; the unused connection stays pending and is never shown.

**When we would need our own app:**

- Users must see "Textcrew", not "Composio", when they allow access.
- We pass 20,000 actions or 10,000 trigger events a month.
- "When an email arrives" must be faster than 15 minutes.
- Code work through git on GitHub (section 11).

**Before switching:** Google must review an app that reads Gmail before it can pass 100 users, so that review must start early. Users who connected through the shared app stay on it until they connect again.

---

## 9. Hiding Composio's name from users

When a user connects an app, Composio can show up in four places. The web app now shows its own connect screen first, so the first thing a user sees is ours. Hiding the rest takes steps that only you can do, outside our code.

| Where | What the user sees today | What hides it | Time |
|---|---|---|---|
| **1. Composio's connect page** | Composio's logo, and "Composio wants to connect to your account" | Our logo and name in Composio's dashboard (step 1). With our own sign-in app the page is skipped altogether | 5 minutes |
| **2. The provider's "Allow" screen** | "Composio wants to access your Google Account" | Our own sign-in app at that provider (steps 2 and 3) | GitHub: about 20 minutes. Google: weeks, because Google reviews it |
| **3. The address bar on the way out** | `backend.composio.dev`, for a moment | Already done in our code: with our own sign-in app, the link goes straight to the provider | Nothing to do |
| **4. The address bar on the way back** | `backend.composio.dev`, for a moment | Our own way-back address, `https://api.textcrew.in/oauth/callback` (step 4) | 5 minutes per sign-in app |

Places 2 to 4 change only for an app with our own sign-in app. Apps on Composio's shared sign-in keep Composio's name on the provider's screen.

### Step 1. Our logo and name on Composio's page (every app, no code)

1. Sign in at `https://dashboard.composio.dev`. Choose the project whose key is on our server.
2. Open **Project Settings**, then **White Labeling**, then the **Branding** tab.
3. Set **App Title** to `Textcrew`. Upload the logo: a square PNG or JPEG, between 256 × 256 and 1024 × 1024 pixels.
4. Save. The **Styling** tab can set our colors and fonts too. Composio says it is not switched on for every project yet.
5. Check: connect an app that is on Composio's shared sign-in. Composio's page shows our logo and "Textcrew wants to connect to your account".

What stays: the "Secured by Composio" badge on that page, and Composio's name on the provider's own "Allow" screen. Both go only with our own sign-in app.

### Step 2. Our own GitHub sign-in app (GitHub does no review)

**Part A. At GitHub**

1. Sign in to GitHub. An organization account is better than a personal one as the owner: the app stays if a person leaves.
2. Open **Settings**, then **Developer settings**, then **OAuth Apps**, then **New OAuth App**. For an organization, it is the organization's **Settings**, then **Developer settings**.
3. Fill in:
   - **Application name:** `Textcrew`
   - **Homepage URL:** `https://textcrew.in`
   - **Authorization callback URL:** `https://backend.composio.dev/api/v3/toolkits/auth/callback`. Use `https://api.textcrew.in/oauth/callback` instead if you do step 4 now.
4. Click **Register application**. Upload the logo on the next page.
5. Click **Generate a new client secret**. Copy the **Client ID** and the secret. Paste the secret only into Composio, in part B. Do not paste it into a chat or a file.

**Part B. In Composio's dashboard**

6. Open **Auth Configs** and click **Create Auth Config**. Choose **GitHub**, then **OAuth2**.
7. Switch on **Use your own developer credentials**. Paste the Client ID and the Client Secret.
8. Set **Redirect URI** to exactly the callback URL from step 3.
9. Leave the scopes as Composio suggests.
10. Click **Create**. Copy the new id. It starts with `ac_`.

**Part C. On our server**

11. Log in to the server and open `/opt/textcrew/beckend/.env`. In the line `COMPOSIO_AUTH_CONFIGS=`, replace GitHub's old id with the new one. Keep the line whole, as in section 8.
12. Restart the api and the worker:
    ```sh
    cd /opt/textcrew && ./dc --profile app up -d --force-recreate --no-deps api worker
    ```
13. Check, with your own user id:
    ```sh
    cd /opt/textcrew && ./dc --profile app exec -T api node --import tsx scripts/dev-user.ts connect-app --user <your user id> --app github
    ```
    The second line must say "sign-in: straight to the provider's page (our own sign-in app)". The link opens GitHub's own page, and it names Textcrew.

Good to know:

- **An organization can block outside apps.** A user whose GitHub organization limits OAuth apps sees a "request access" button for that organization's repos. Their organization's admin must approve Textcrew once. Personal repos are not affected.
- **Git through our gateway** (Byte pushing code, Patch reading code for a review) needs the user's GitHub token from Composio. Composio always hides it for its shared GitHub app (section 11). With our own GitHub app it may be readable. Not confirmed: try it after this step.

### Step 3. Our own Google sign-in app (Google reviews it first)

Start this early. It is the slow one.

- **Why it is slow.** Reading Gmail needs permissions that Google calls "restricted". An app that asks for them must pass Google's verification, and a security assessment by an outside lab that is repeated every year (Google calls it CASA). Expect six weeks or more, and a fee for the assessment.
- **Until Google has verified the app,** users see a warning that the app is unverified, and at most 100 users can sign in to it.
- **Calendar, Drive, Docs and Sheets** need their own permissions. Some are lighter to get than Gmail's, some are as strict. Check each one in Google's list when you start.
- These points were read in Google's help pages before this change. They could not be opened again from here, so treat them as not confirmed for today.

The outline:

1. In the Google Cloud console, make a project for Textcrew.
2. Set up the **OAuth consent screen**: the app name `Textcrew`, the logo, a support email, the privacy policy and terms pages (the legal pages are still to be written), and `textcrew.in` as an authorized domain. Google asks you to prove you own the domain, in Google Search Console.
3. Switch on the **Gmail API** (and the Calendar, Drive, Docs and Sheets APIs if you want them).
4. Make an **OAuth client ID** of the kind **Web application**. As the redirect address, use our own: `https://api.textcrew.in/oauth/callback` (step 4). Google wants the domains an app uses to be ones we own, and `backend.composio.dev` is not ours. Not confirmed whether Google would accept Composio's address; our own avoids the question.
5. In Composio's dashboard, create an auth config for **Gmail**, **OAuth2**, with **Use your own developer credentials**, the Google client id and secret, and the same redirect address. One Google sign-in app can serve Gmail, Calendar, Drive, Docs and Sheets: each gets its own auth config in Composio, all with the same client id and secret.
6. Put the new ids in `COMPOSIO_AUTH_CONFIGS` and restart, as in step 2, part C. Until Google has verified the app, keep Gmail on Composio's shared app for real users, or switch only on a test server.
7. In the Google Cloud console, send the app for verification. Google then asks for the security assessment.

### Step 4. Our own way back (one setting per sign-in app)

After the user clicks **Allow**, the provider sends the browser back to the sign-in app's redirect address. By default that is Composio's. To make it ours:

1. At the provider, set the sign-in app's callback or redirect address to:
   ```text
   https://api.textcrew.in/oauth/callback
   ```
2. In Composio's dashboard, open the same auth config and set its **Redirect URI** to the same address. Both must match exactly. If they do not, the provider shows an error such as "redirect_uri mismatch".
3. Nothing to change on our server. The api already answers that address: it sends the browser straight on to Composio, with the same details. It saves nothing and writes nothing of it to the logs.

This works only for our own sign-in apps. Composio's shared apps always come back through Composio's address.

### Step 5. Switching an app that people already use

- **Existing connections stay on the old setup and keep working.** Composio keeps renewing them with the old one.
- **Only new connections use the new setup.** So a user who connected GitHub before the switch still has a GitHub screen that named Composio, and a token from Composio's app.
- **To move a user over,** they disconnect the app under **Apps** and connect it again. The web app does not ask them to; tell your beta users yourself, for example on Telegram.
- **Do not delete the old setup in Composio** while connections still use it. Deleting a setup stops every connection made with it.
- **An app the server set up by itself** (`COMPOSIO_MANAGED_APPS`): putting the new id in `COMPOSIO_AUTH_CONFIGS` is enough. That setting wins.

---

## 10. What it costs

### 10.1 What Composio charges us

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

### 10.2 What we charge our users

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

### 10.3 One worked example

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

## 11. What can go wrong

| What happened | What the user sees | What to do |
|---|---|---|
| **The app has no setup on our server** | "Not available yet" in the web app, and no Connect button | Section 8 |
| **Composio will not make an app's setup,** or is down while someone connects | "Google Calendar can't be connected right now". Nothing is saved | Check that the Composio key has full access. Or make the setup the dashboard way (section 8) |
| **The user stops on the provider's page,** or the provider refuses | "Gmail didn't connect" in the web app | Nothing. They can press Connect again |
| **Our own sign-in app's redirect address does not match** | The provider shows an error such as "redirect_uri mismatch" | Make the address the same at the provider and in Composio (section 9, step 4) |
| **Connected, but Tex can't see it.** The web app said "Google Calendar is connected", but Tex says it isn't there | Tex says the app is still connecting, or that it needs connecting again on the Apps page | Run the `apps` check below |
| **The connection expired.** The user changed their password or removed our access at Google | The web app shows "Expired" and a **Reconnect** button. Tex says the app is not connected, or reports an error from the app | The user clicks Reconnect |
| **Composio or the app is down** | Tex says the app is unavailable right now. Nothing is charged. An approval already given still works later | Wait |
| **Composio's free limit is reached** | Actions fail. Tex reports an error or says the app is unavailable | Wait for next month, or move to Pro |
| **Composio's webhook does not reach our server** | "When an email arrives" never fires. Pull-request review never starts | Set the webhook address (section 7) |
| **Composio hides the GitHub token** | Git answers "The GitHub connection can't be used for git". Byte cannot clone or push, and Patch cannot read the code for a review. GitHub actions through Composio still work | See below |

**Connected, but Tex can't see it, in more words.** On 13 October the founder connected Google Calendar, and Tex answered that only GitHub was connected. Three things in our server could cause that, and all three are fixed:

- Our server asked Composio for the actions of all connected apps at once, with one limit of 200 for all of them. GitHub alone has more than 200, so Google Calendar's actions never made it into Tex's list. Now each app is asked for separately, and the 100 actions Tex sees are shared fairly between the apps. This is the most likely cause.
- Tex's own tools never asked Composio whether a pending connection had finished, and left a pending app out without a word. Now they ask first, and say "Google Calendar is still connecting" when it is.
- The check read the user's whole list of accounts at Composio, which comes in pages, so a new account could be missed. Now it asks about each connection by its id.

To see where a user's apps stand, run this on the server, with the user's email (or `--user <user id>`):

```sh
cd /opt/textcrew && ./dc --profile app exec -T api node --import tsx scripts/dev-user.ts apps --email <the user's email>
```

It prints, newest first:

- one `connection` line per connection: the app, our status (`pending`, `active`, `expired`, `error`), when it was started, Composio's account id (it starts with `ca_`), and what Composio says about that account: its status, its app and the setup it was made with;
- one `setup` line per app: the setup id and where it comes from (`COMPOSIO_AUTH_CONFIGS`, or made by the server);
- `composio also has …` for an account Composio has for this user that our server has no connection for;
- one `agent sees` line per app: what Tex gets from `list_app_actions`, with the note Tex is given when the app is not ready.

What the answers mean:

| You see | It means | What to do |
|---|---|---|
| `active`, "Composio: ACTIVE", "agent sees …: connected" | All is well | Ask Tex again, in a new message |
| `pending`, "Composio: INITIATED" | The sign-in is not finished at the provider | Wait a minute. If it stays so, connect again from the Apps page |
| `pending`, "Composio: no such account" | Composio does not know that account | Connect again from the Apps page |
| "Composio: ACTIVE (app github …" on a Google Calendar line | The setup used is another app's | Tell Claude: the setup in the table `composio_auth_configs` is wrong |
| `expired` or `error` | The connection stopped working | Reconnect from the Apps page |

**The hidden token, in more words.** Our git gateway lets the agent use normal git on the user's GitHub. For that, our server asks Composio for the user's GitHub token. Composio hides ("masks") tokens in its answers.

- Our design counted on one Composio project setting, "mask connected account secrets", being switched off.
- Composio's change note of 22 April 2026 says that for a connection made through its shared app, the token is always hidden, whatever that setting says.
- So with the shared GitHub sign-in, the setting does not help. Git through our gateway, and pull-request review with it, would need our own GitHub app at Composio.
- Composio's newer help pages say tokens are hidden for own apps too. So it is not confirmed that this can work at all. It has never run for real on the test server.

---

## 12. Words used

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
| **Our own sign-in app** | An app we register at the provider (GitHub, Google), whose name the user sees on the "Allow" screen. Composio calls the setup that uses it a custom auth config |
| **Connect Link** | Composio's own connect page, which comes before the provider's page for Composio's shared sign-in |
| **White labeling** | Composio's word for putting our name and logo where its own would be |
| **Redirect address** | Where the provider sends the browser after the user clicks Allow. Also called the callback URL or redirect URI |
| **Session, direct execution** | Composio's new way and old way of running actions. We use the old one |

---

## 13. Sources

All read on 9 October 2026, except the second list.

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

Read on 13 October 2026, for section 9 and the new parts of sections 4 and 8. `docs.composio.dev` could not be reached from where this was written, so the same pages were read in the source of Composio's help site, at `github.com/ComposioHQ/composio`, branch `next`, folder `docs/content/docs/`:

- The four places Composio shows, and how to hide each: `auth-configuration/white-labeling.mdx` (the page `https://docs.composio.dev/docs/auth-configuration/white-labeling`)
- The end of `initiate()` for Composio's shared sign-in, and how to tell the two kinds of setup apart (`isComposioManaged`): `auth-configuration/migrating-initiate-to-link.mdx`
- Our own sign-in app at a provider: `auth-configuration/custom-auth-configs.mdx` and `authentication/custom-app-vs-managed-app.mdx`
- What Composio adds to the address when the browser comes back (`status`): `tools-direct/authenticating-tools.mdx`
- Composio's code library, version 0.21, as our server uses it: `initiate()`, `link()`, `authConfigs.get()`, `authConfigs.list()` and `authConfigs.create()`
