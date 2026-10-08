# The domain textcrew.in: how it is set up

This explains where `textcrew.in` was bought, who controls it, and where each name points. It also gives the steps to add a new name, and to move the backend to another server.

The facts here were checked with commands on 8 October 2026. Where something could not be checked, it says "not confirmed".

## 1. In short

| | |
|---|---|
| **Bought at** | GoDaddy, on 28 September 2026. GoDaddy is still the registrar |
| **Paid until** | 28 September 2027. Renewal is paid at GoDaddy |
| **Who answers DNS** | Vercel, with the nameservers `ns1.vercel-dns.com` and `ns2.vercel-dns.com` |
| **Where records are edited** | In Vercel only. Records typed in at GoDaddy do nothing |
| **Vercel account** | `rahulcoder9417`, team `rahulcoder9417s-projects`, Hobby plan |

**The names in use:**

| Name | What it is | Where it points | State on 8 October 2026 |
|---|---|---|---|
| `textcrew.in` | The landing page | Vercel project `personal-agent-landing-page` | Works |
| `www.textcrew.in` | The landing page | The same project. It redirects to `textcrew.in` | Works |
| `app.textcrew.in` | The web app | Vercel project `textcrew-app` | Works. Added that day |
| `api.textcrew.in` | The backend | The AWS test server, fixed IP `3.111.132.222` | Works. Added that day |
| `send.textcrew.in` | Email sent by Resend | Resend's mail system | The records exist |

**The Vercel commands in this file** are run from the web app folder. Go there first:

```sh
cd "/home/rahul/Desktop/coding/projects/b2b ai saas/1_personal_agent/user-frontend-web"
```

## 2. The words

| Word | What it means |
|---|---|
| **Domain** | A name you rent on the internet. Ours is `textcrew.in` |
| **Registrar** | The company you rent the domain from and pay each year. Ours is GoDaddy |
| **DNS** | The internet's phone book. It turns a name into the address of a computer |
| **IP address** | The number address of a computer, like `3.111.132.222` |
| **Nameserver** | The computer that answers DNS questions for a domain. Ours are Vercel's |
| **DNS record** | One line in the phone book. It says "this name points there" |
| **Subdomain** | A name in front of the domain, like `api` in `api.textcrew.in`. Subdomains are free |
| **A record** | A record that points a name at an IP address |
| **CNAME** | A record that points a name at another name, not at an IP address |
| **ALIAS** | Like a CNAME, but it also works on the bare domain. Vercel uses it |
| **TXT record** | A record that holds one line of text. Email services read it |
| **MX record** | A record that says which server takes mail for a name |
| **Wildcard (`*`)** | A record that answers for every name that has no record of its own |
| **TTL** | "Time to live", in seconds. How long others may remember an answer before they ask again |
| **Certificate** | A file that proves a site really owns its name. It makes `https://` work |

**Example:** a browser opens `api.textcrew.in`. It asks Vercel's nameservers. They answer `3.111.132.222`. The browser then connects to that server.

## 3. How the domain moved from GoDaddy to Vercel

**What "moved" means here.** Only one setting changed: the nameservers. The domain itself did not move. You still rent it from GoDaddy.

| | Before | Now |
|---|---|---|
| **Registrar** (who you pay) | GoDaddy | GoDaddy. No change |
| **Nameservers** (who answers DNS) | GoDaddy's own. Not confirmed: this is only GoDaddy's usual default | Vercel's |
| **Where records are edited** | GoDaddy | Vercel |

**What was done, in order:**

1. You bought `textcrew.in` at GoDaddy on 28 September 2026.
2. The domain was added to the Vercel account the same day, for the landing page project.
3. Vercel showed its two nameserver names: `ns1.vercel-dns.com` and `ns2.vercel-dns.com`.
4. At GoDaddy, the domain's nameservers were changed to those two names.
5. Vercel saw the change. Its certificate for `textcrew.in` is dated 29 September 2026.
6. The email records for Resend were added in Vercel on 29 September 2026.

The exact clicks at GoDaddy were not written down. The setting is called "Nameservers". Its menu path is not confirmed.

**How to check it.** This command asks the internet who answers for the domain:

```sh
curl -s 'https://dns.google/resolve?name=textcrew.in&type=NS'
```

The answer must name `ns1.vercel-dns.com` and `ns2.vercel-dns.com`. This command asks Vercel the same question:

```sh
pnpm dlx vercel@latest domains inspect textcrew.in
```

It shows "Registrar: Third Party" and a tick next to each nameserver. "Third Party" means the domain was bought somewhere else. Here that is GoDaddy.

**What still happens at GoDaddy:**

- **Renewal.** You pay GoDaddy each year. The next date is 28 September 2027. If it is not paid, every name stops: site, app, api and email. Whether auto-renew is switched on is not confirmed.
- **The nameserver setting.** It lives at GoDaddy. Do not change it back.
- **Nothing else.** You never add records at GoDaddy now.

**Example:** you want a new name, `docs.textcrew.in`. You do not open GoDaddy at all. You do it in Vercel (section 5).

## 4. The records today

To list them:

```sh
pnpm dlx vercel@latest dns ls textcrew.in
```

**Records that were added by hand:**

| Name | Type | Points to | TTL | What it is for |
|---|---|---|---|---|
| `api` | A | `3.111.132.222` | 60 s | The backend on the AWS test server. Added on 8 October 2026 |
| `send` | MX | `feedback-smtp.ap-northeast-1.amazonses.com`, priority 10 | 3600 s | Resend: where reports about failed emails go |
| `send` | TXT | `v=spf1 include:amazonses.com ~all` | 3600 s | Resend, called SPF: says which servers may send our mail |
| `resend._domainkey` | TXT | `p=MIGfMA0GCSqGSIb3...` (a long key, cut short here) | 3600 s | Resend, called DKIM: a key that proves an email is really ours |
| `_dmarc` | TXT | `v=DMARC1; p=none;` | 60 s | Called DMARC: tells mail services what to do with fake mail. `p=none` means "do nothing" |

Resend sends the waitlist emails from `no-reply@textcrew.in`. It sends through Amazon's mail system, so the values say `amazonses.com`.

**Records that Vercel made by itself.** Vercel's help says these cannot be removed.

| Name | Type | Points to | What it is for |
|---|---|---|---|
| `textcrew.in` (the bare domain) | ALIAS | `2c086a4aaf472ede.vercel-dns-017.com` | Sends the bare domain to Vercel |
| `*` (every other name) | ALIAS | `cname.vercel-dns-017.com` | Sends every name without its own record to Vercel |
| `textcrew.in` | CAA, three rows | `letsencrypt.org`, `pki.goog`, `sectigo.com` | CAA lists who may make certificates for the domain. These three may |

**Two things to notice:**

- `www` and `app` have no row. The `*` row answers for them and sends them to Vercel. Vercel then looks up which project owns the name.
- `api` has its own row. Its own row wins over `*`. So `api` goes to the server, not to Vercel.

**Example:** `anything.textcrew.in` is not set up anywhere. It still gets an answer, because of `*`. It lands at Vercel, and the browser shows a certificate error.

**About the old address.** The backend used to be reached as `3-111-132-222.sslip.io`. `sslip.io` is a free service that needs no DNS setup. Such a name gives the IP address written inside it. The server now uses `api.textcrew.in`. The old address no longer answers on HTTPS.

## 5. How to add a subdomain

There are two recipes. Pick by where the name must go.

### A. The name goes to a Vercel project

Example: `app.textcrew.in` for the project `textcrew-app`.

1. Open vercel.com and pick the project.
2. Open **Settings** in the sidebar, then **Domains**.
3. Click **Add Domain**. Type the full name, `app.textcrew.in`.
4. Wait until Vercel shows the name as ready.
5. Check with `curl -sI https://app.textcrew.in`. The first line must start with `HTTP`. A certificate error means the name is not ready yet.

Steps 1 to 3 can also be done with one command:

```sh
pnpm dlx vercel@latest domains add app.textcrew.in textcrew-app
```

You add no DNS record. The `*` record already sends the name to Vercel. Vercel makes the certificate by itself.

### B. The name goes to a server

Example: `api.textcrew.in` for the server at `3.111.132.222`.

1. Get the server's fixed IP address.
2. Add an A record. In Vercel, open **Domains** in the sidebar and click `textcrew.in`. Fill in the DNS record form: **Name** is `api` only, **Type** is `A`, **Value** is the IP address. Leave **TTL** at 60. Click **Add**. Or use one command:
   ```sh
   pnpm dlx vercel@latest dns add textcrew.in api A 3.111.132.222
   ```
3. Check with `getent hosts api.textcrew.in`. It must print the IP address.
4. On the server, give Caddy the new name. Caddy is the program that takes all web traffic on the server. For the api, the name is `API_DOMAIN` in `/opt/textcrew/compose.env`. Then run the deploy, so Caddy starts again with the new name.
5. Caddy asks Let's Encrypt for a certificate by itself. Ports 80 and 443 must be open for this.
6. Check with `curl -s https://api.textcrew.in/healthz`. It must print `{"status":"ok"}`.
7. Change the other places that hold an old address:

| Where | Setting | New value |
|---|---|---|
| The server, `beckend/.env` | `PUBLIC_API_URL` | `https://api.textcrew.in` |
| The server, `beckend/.env` | `WEB_APP_URL` and `CLERK_AUTHORIZED_PARTIES` | `https://app.textcrew.in` |
| The web app's settings in Vercel | `TEXTCREW_API_URL` | `https://api.textcrew.in` |
| Telegram | The bot's webhook | `https://api.textcrew.in/webhooks/telegram` |

For `api.textcrew.in`, steps 1 to 6 are done. Step 7 could not be checked from outside, so it is not confirmed.

## 6. When the server moves to the VPS

Only one record changes: `api`. The name stays the same, so users see no change. The landing page, the web app and email are not touched.

1. Set up the backend on the VPS first, with its data. Keep the AWS server running.
2. On the VPS, set `API_DOMAIN` to `api.textcrew.in`. Open ports 80 and 443.
3. Write down the VPS's fixed IP address.
4. Do not lower the TTL. It is already 60 seconds.
5. List the records (section 4) and copy the id of the `api` row. Today it is `rec_59d6ba345c972c9464558c23`.
6. Change the record's value to the VPS's IP address:
   ```sh
   pnpm dlx vercel@latest dns update rec_59d6ba345c972c9464558c23 --value <VPS IP>
   ```
   Or in Vercel: **Domains**, then `textcrew.in`, find the `api` row, and edit its value.
7. Wait about one minute. Then ask the backend, and see which server answered:
   ```sh
   curl -s -w '\n%{remote_ip}\n' https://api.textcrew.in/healthz
   ```
   It must print `{"status":"ok"}`, and then the VPS's IP address.
8. Send the bot a Telegram message. It must answer. The webhook holds the name, not the IP address, so it needs no change.
9. Only then stop the AWS server.

A certificate error right after step 6 is expected. Caddy can only get its certificate after the name points at the VPS. How long that takes was not measured.

The `dns update` command comes from the Vercel tool's own help. It has not been run on this domain yet.

**Example:** the VPS's IP address is `203.0.113.10` (a made-up number). Step 6 then ends with `--value 203.0.113.10`.

## 7. If something does not work

| What you see | What to check |
|---|---|
| A name gives no answer at all ("server not found") | Run the nameserver check in section 3. Then check at GoDaddy that the domain is paid |
| `api` gives a Vercel address, not the server's | The `api` record is missing or mistyped, so `*` answered. List the records (section 4) |
| Certificate error on a Vercel name | The name is not added to any project. Do recipe A |
| Certificate error on `api` | Caddy has no certificate for that name. Check `API_DOMAIN`, ports 80 and 443, and that the record gives this server's IP address |
| The site shows the wrong project | Run `domains inspect` (section 3). It lists each project with its names. Remove the name from the wrong project, then do recipe A |
| A Vercel name gives "404" | The name works. The answer comes from the app itself. On 8 October 2026 a plain `curl` to `app.textcrew.in/` got 404, because the app sends only real browsers to the sign-in page. In a browser the same address opens the sign-in page |
| Email lands in spam | List the records: the four email rows must still be there. Check in Resend that the domain shows as verified (not checked here). `_dmarc` is `p=none`, the weakest setting |
| A change does not show yet | Wait for the TTL: 60 seconds for `api`, up to 30 minutes for Vercel's own rows |
