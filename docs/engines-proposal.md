# More engines: Codex and every "bring your own" agent

A design proposal. Nothing is built. No code, contract or server was changed.

Written on 8 October 2026. Read for it: `hld-mvp.md` (sections 6, 8, 10), `backend-report.md` (sections 20, 21, 30, 34, 35), the Bridge (`claude.py`, `hermes.py`, `runtime.py`, `crew.py`, `platform.py`, `server.py`, `lead_gate.py`), the agent image's `Dockerfile`, `vm.proto`, `internal/sandbox/claude.go`, the backend's `openapi.yaml` and `orchestrator/schema.ts`, the Hermes source at our pinned commit, and the web pages listed in section 12.

## Contents

1. In short
2. How Claude Code was added: the checklist
3. What each program can do
4. OpenAI's rules, in its own words
5. Codex: the design
6. The other engines
7. API keys: the list for Hermes
8. One change that makes every new engine cheaper
9. Risks
10. Decisions for you
11. The ranked list
12. What I could not confirm, and the sources

---

## 1. In short

- **A ChatGPT plan cannot be offered today.** OpenAI's own pages say that a paid or hosted service may not use the Codex sign-in for its users. It must use a new program, "Sign in with ChatGPT", and a paid or hosted app must ask for access on a waitlist first. The exact sentences are in section 4.
- **Codex with the user's own OpenAI API key is allowed** and fits our design well. It is close to a twin of the Claude Code engine. Size: medium.
- **"Every API key" needs no new engine.** Hermes, at the version we pin, already talks to about 40 providers with a key. The list is in section 7.
- **The best second subscription is GitHub Copilot.** Its licence says the unchanged program may be shipped "as part of an application or service", and its sign-in is made for machines with no browser.
- **A free way to test exists.** A Gemini API key needs no card: 250 requests a day. It works in Hermes, so it needs no new engine either.
- **Three programs are not worth adding:** OpenCode, Qwen Code and Cursor's CLI.

| Engine | The user brings | Allowed for a hosted, paid service? | When |
|---|---|---|---|
| Hermes, more key providers | Any API key | Yes | Now |
| Codex CLI | An OpenAI API key | Yes | Now, after a one-day trial |
| GitHub Copilot CLI | A Copilot plan | The licence allows shipping it. Hosting for users is not named: ask GitHub | Later, first in line |
| Gemini CLI | A Gemini API key (free tier) | Yes with a key. Google sign-in: unclear | Later |
| Codex CLI | A ChatGPT plan | **No, until OpenAI says yes** | When OpenAI approves |
| OpenCode, Qwen Code, Cursor CLI | | See section 6 | Never |

---

## 2. How Claude Code was added: the checklist

Every new engine needs the same eight pieces. This is what exists for Claude Code today.

| # | Piece | Where | What it does for Claude Code |
|---|---|---|---|
| 1 | Install and pin | `agent-image/Dockerfile` | Version 2.1.283, checked against Anthropic's signed list, not changed |
| 2 | Runtime module | `bridge/claude.py` | Runs `claude -p` once per message, reads its event stream, keeps one session per chat |
| 3 | The crew | `bridge/crew.py`, `lead_gate.py` | Byte, Patch and Scout as sub-agents with tool lists that are locks |
| 4 | Sign-in | `claude.py` (`ClaudeAuth`), `server.py` | Start, finish with a pasted code, sign out. The program keeps its own sign-in file in `/data/claude` |
| 5 | vm-manager | `vm.proto`, `sandbox/claude.go` | `SetAgentRuntime`, `StartClaudeLogin`, `CompleteClaudeLogin`, `ClaudeLogout` |
| 6 | Way out | `CLAUDE_EGRESS_DOMAINS` | Four Anthropic hosts, open only while Claude Code is the engine or a sign-in runs |
| 7 | Backend | `openapi.yaml`, `agent-settings.ts`, `claude-login.ts` | Three endpoints, the engine choice, "no AI credits" |
| 8 | Web app | Settings | Connect, paste the code, disconnect, choose the engine |

---

## 3. What each program can do

Checked on 8 October 2026. "Not confirmed" means the docs I opened did not say.

| | Codex CLI | Gemini CLI | Copilot CLI | OpenCode | Cursor CLI |
|---|---|---|---|---|---|
| Version | 0.161.0 (7 Oct 2026) | 0.63.0 | 1.0.93 | 1.18.35 | Not checked |
| Licence | Apache-2.0, open source | Apache-2.0, open source | GitHub's own; may be shipped unchanged inside a service | MIT, open source | Closed. Terms forbid copying it |
| Runs with no screen | `codex exec` | `gemini -p` | `copilot -p` | `opencode run` | `agent -p` |
| Events for a machine | `--json`: one JSON line per event | `--output-format stream-json` | Not confirmed | `--format json` | `--output-format stream-json` |
| Sign-in with no browser on the machine | Device code: a link and a short code. Marked beta. The user must switch it on in ChatGPT's security settings | Not documented. Docs say: use an API key | Device code is the default in containers | Depends on the provider | `NO_OPEN_BROWSER=1` prints a link |
| Sign-in with a key | `CODEX_API_KEY` | `GEMINI_API_KEY` | A narrow token in `COPILOT_GITHUB_TOKEN` | Yes, 75+ providers | `CURSOR_API_KEY` |
| Where the sign-in lives | `auth.json` under `CODEX_HOME` | `~/.gemini` | `~/.copilot/config.json` when there is no keychain | `~/.local/share/opencode/auth.json` | Not checked |
| MCP over HTTP with a token | Yes. The token can stay in an env variable | Yes | Yes, with headers | Yes | Not checked |
| Helpers (sub-agents) | Yes: one file per agent | Yes: one file per agent | Yes: one file per agent | Yes | Not checked |
| A tool list per helper | For MCP tools: yes. For the shell and file edits: no | Yes, a real list | Not confirmed | Per-agent allow and deny | Not checked |
| Built-in web search | Yes, runs at OpenAI. A cached mode exists | Yes | Not confirmed | No | Not checked |
| Continue a session | `codex exec resume <id>` | Yes | Yes | `--session` | Yes |
| Free tier | No. Plus or Pro, or a paid API key | Yes: 1,000 requests a day with a Google sign-in, 250 with a free key | Docs: "available with all Copilot plans" | The program is free | No |

**Codex inside our container.** On Linux Codex builds its own inner sandbox with a tool called bubblewrap. OpenAI's docs say this may not work inside a container, and then: "configure your Docker container to provide the isolation you need, then run `codex` with `--sandbox danger-full-access`". Our gVisor container is that isolation. So we would switch Codex's own sandbox off. I did not test whether bubblewrap runs under gVisor.

**Hosts Codex must reach.** The docs name `api.openai.com` (API key use), `auth.openai.com` (sign-in, the device code page) and `chatgpt.com` (the ChatGPT plan). I found no official full list.

---

## 4. OpenAI's rules, in its own words

OpenAI moved its Codex docs to `learn.chatgpt.com`. Its policy pages refused my reader, so I read saved copies of them from 31 August and 6 to 7 October 2026 (web.archive.org).

**The sentences that forbid it**

1. Codex docs, page "Codex App Server", part "Auth endpoints":
   > "App-server authentication has never been permitted for commercial or hosted services. We launched Sign in with ChatGPT to support these use cases, and we're excited to see what you build. Join our partner waitlist."
2. OpenAI's cookbook for Sign in with ChatGPT, part "Usage policy and terms":
   > "The ChatGPT plan usage integration described here is available for open-source tools and personal projects that run locally. If you're building a paid or remotely hosted app, join the waitlist to request access before offering it to users."
3. Sign in with ChatGPT Terms, dated 29 September 2026:
   > "Any persistent storage of Authentication Tokens must be local and under the user's control, not in a remote or managed environment."
   > "Requests must originate from the user's local runtime or a remote runtime only that user controls."
   > "Another user's activity must not trigger requests to the authenticated user's account."
   > "No charge. Users must be able to use their ChatGPT plan through SIWC without paying you or upgrading to a paid version of your application."
4. Terms of Use, in force since 1 January 2026:
   > "You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account."

**The sentences that allow something**

5. Codex docs, page "Authentication":
   > "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs. Don't expose Codex execution in untrusted or public environments."
6. Sign in with ChatGPT Terms: "These restrictions do not affect separately authorized API use."
7. Sign in with ChatGPT quickstart:
   > "Sign in with ChatGPT is currently available to selected commercial partners through a limited trial."

**What this means for us**

| Question | Anthropic (Claude plans) | OpenAI (ChatGPT plans) |
|---|---|---|
| May a hosted service run the unchanged program on the user's own plan? | Yes, with three conditions (HLD section 10) | No. Sentence 1 says it was never permitted |
| Is there an approved way? | Yes, the one we built | Yes: Sign in with ChatGPT. For a paid or hosted app it is by waitlist only |
| Where may the sign-in be kept? | In the user's container: a known grey area | "Local and under the user's control, not in a remote or managed environment" |
| May we charge? | Not for their usage | The user must be able to use their plan "without paying you" |

Three of our features collide with sentence 3 even if OpenAI lets us in:

- Our container is a "managed environment". The sign-in file would sit on our server.
- Pull-request review starts when **another person** opens a pull request. That is "another user's activity".
- We charge credits for awake time. A user with no credits cannot use their plan. That may break "No charge".

A hosted partner may get different terms. Those are not public. Only OpenAI can tell us.

---

## 5. Codex: the design

Two ways to pay, one engine:

| Way | State | Sign-in |
|---|---|---|
| The user's OpenAI API key | Allowed. Build this | No sign-in in the container. It is a key |
| The user's ChatGPT plan | Not allowed yet | Device code, added later (5.5) |

### 5.1 The agent image

- A new build stage, like the Claude one. It downloads the Codex binary for version 0.161.0 from OpenAI's release page. The Linux build is one static file and comes with a signature file. The build checks it and fails if it does not match.
- The program is not changed. It is Apache-2.0, so shipping it is allowed.
- `CODEX_HOME=/data/codex`, in the user's own folder. The system files stay read-only.
- Update checks and usage statistics are switched off by settings.
- Bubblewrap is not installed, because the inner sandbox is off.

### 5.2 The Bridge runtime module (`codex.py`)

One message is one run of `codex exec --json`. The prompt goes in on standard input, as it does for Claude Code.

| What the Bridge needs | Claude Code today | Codex |
|---|---|---|
| Start a turn | `claude -p --output-format stream-json` | `codex exec --json --skip-git-repo-check --sandbox danger-full-access`, approvals set to "never" |
| One session per chat | `--session-id`, then `--resume` | The first event gives a thread id. Later turns use `codex exec resume <id>` |
| Platform tools | `--mcp-config` file with the token in it | `config.toml`: the server's address, and the **name** of an env variable that holds the token. The token stays out of the file |
| No tool may wait for a yes | `dontAsk` mode and an allow list | `default_tools_approval_mode = "approve"` on our servers. Without it a tool call fails in this mode |
| `send_message` hidden | Deny list | `disabled_tools = ["send_message"]` on the platform server |
| Progress lines | `tool_use` events | `item.started` events: command, MCP tool call, web search, file change |
| The answer | The `result` event | The last `agent_message` item, then `turn.completed` |
| Failure | `result` with an error | `turn.failed` or `error`. The texts must be collected from real runs |
| The turn's instructions | `--append-system-prompt` | A settings key or an `AGENTS.md` file. To be fixed in the trial |

Two more rules, copied from the Claude module:

- The Bridge removes `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` and `OPENAI_BASE_URL` from Codex's environment unless they are the user's own. So Codex can never run on our gateway key by accident.
- Codex's own memory is switched off. Memory stays on the platform, shared by all engines.

Web search must be set by hand. With the sandbox off, the docs say search "defaults to live results". We want the cached mode for Scout: it reads from OpenAI's own index and not from live pages.

### 5.3 The crew on Codex

Codex has sub-agents. Each is one small file with a name, a description, instructions, and its own settings. So Tex, Byte, Patch and Scout map onto it by name. The Bridge writes the three files from `crew.py`, the same single definition as today.

| Rule | On Claude Code | On Codex |
|---|---|---|
| Tex starts a specialist by name | Lock | Works, by the docs |
| At most 3 at once | Lock | Lock: one setting |
| A specialist cannot start another | Lock | Likely: the multi-agent tools can be switched off in the specialist's file. To test |
| Nobody calls `send_message` | Lock | Lock |
| Each specialist's platform tools | Lock | Lock: each agent file can carry its own tool list for an MCP server |
| Only Scout searches the web | Lock, by a small check before each call | Likely: search off for Tex, on in Scout's file. To test. Codex's hooks do not see its built-in search |
| Patch cannot change files | Lock | **Instruction only.** A read-only helper needs Codex's inner sandbox, which is off |
| Scout has no files and no shell | Lock | **Instruction only.** The docs show no way to take the shell from one helper |
| "Scout: reading 4 pages" lines | From the event stream | From Codex's `SubagentStart` and `SubagentStop` hooks, or the event stream. To test |

**What is lost.** The last two locks. Scout's lock is the important one: it is why a web page cannot make Scout read a file and send it out. On Codex that would rest on Scout's instructions. So for Codex I propose the strict page-reading rule we already use for Hermes (only addresses already seen), and cached search.

One thing may win a lock back. Codex has a hook that can refuse a shell command or a file edit. If a hook placed in Scout's own file runs only for Scout, the lock returns. The docs do not say. The trial must show it.

### 5.4 The API key

The user already saves an OpenAI key with `PUT /v1/byok/openai`. Codex needs that key at run time. How a user's key reaches an engine is the part another agent is building for Hermes now. Codex should use the same answer, so I did not design it. Codex can also be pointed at a gateway such as LiteLLM, so both routes stay open.

### 5.5 The ChatGPT plan sign-in, for the day OpenAI says yes

Codex can sign in with a device code. This suits us better than the Claude flow:

1. The user presses Connect. The api asks the vm-manager, which wakes the container.
2. The Bridge asks Codex to start a device-code sign-in. Codex answers with a link (`https://auth.openai.com/codex/device`) and a short code, as plain data. No screen-reading is needed.
3. The web app shows the link and the code. The user types the code **on OpenAI's page**.
4. Codex finishes by itself and saves `auth.json` in the user's folder. The web app asks every few seconds whether it is connected.

No secret passes through our server, which removes one of the two grey areas we have with Claude. One extra step for the user: device-code sign-in must first be switched on in their ChatGPT security settings.

If OpenAI instead requires its partner flow, the sign-in comes back to **our backend**, and we would hold the user's tokens. That breaks our rule "we never see the credential". It would be your decision at that time.

### 5.6 The way out

| When | Hosts added to this container's list |
|---|---|
| Codex is the engine, with an API key | `api.openai.com` |
| A ChatGPT sign-in runs, or Codex runs on a plan | Also `auth.openai.com` and `chatgpt.com` |

Same mechanism as today: written at wake, removed at stop, added while a sign-in is pending.

### 5.7 Charging

Like the Claude plan. No AI credits. Awake time, app actions and the browser still cost credits. Codex's built-in search runs at OpenAI on the user's account, so it costs us nothing and the user no credits.

### 5.8 The web app's settings screen

Today the screen has three choices. I propose one list of AI sources, read from the API, so a new engine needs no new screen:

| Source | Shows | Connect by |
|---|---|---|
| Claude plan | Connected since… | A link, then a pasted code (as today) |
| OpenAI API key (Codex) | Last 4 characters | Pasting the key |
| ChatGPT plan (Codex) | Hidden until allowed | A link and a short code to type at OpenAI |
| Other API keys (Hermes) | One row per provider | Pasting the key |
| Textcrew AI | Credits | Nothing |

### 5.9 Contract changes

**gRPC (`vm.proto`, in the vm-manager repo). Only additions; nothing existing changes.**

- `AgentRuntime`: add `AGENT_RUNTIME_CODEX = 3`.
- `Sandbox`: add a list of engine sign-in states (engine, connected). `claude_connected` stays.
- New, generic calls: `StartEngineLogin` (returns a link, an optional short code, and whether a pasted code is needed), `GetEngineLogin` (pending, connected or failed), `CompleteEngineLogin` (only for engines with a pasted code), `EngineLogout`. The three Claude calls stay and keep working.

**REST (`openapi.yaml`).**

- `AgentRuntime`: add `codex`. `aiAccess`: add a value for an own plan that is not Claude.
- `AgentSettings`: add `engines`, a list with id, name, how to connect, connected or not, and whether this server offers it.
- New: `POST /v1/agent/engines/{engine}/login`, `GET …/login/{loginId}`, `POST …/login/{loginId}/complete`, `DELETE /v1/agent/engines/{engine}`. The three `/v1/agent/claude` paths stay.

**Database.**

- vm-manager: `sandboxes.runtime` has a fixed list of two values. One migration widens it. One small table holds the sign-in state per engine.
- Backend: `agent_settings.runtime` and `chat_engines.runtime` accept the new value. A new table `engine_connections` (user, engine, connected at) replaces the single `claude_connected_at` column over time.
- The rule that picks the engine (`decideAccess`) is rewritten once, for "a connected plan, and the user chose that engine".

### 5.10 Size and order

**Size: medium** for Codex with an API key. The sign-in adds a small piece later.

1. You send OpenAI the waitlist form. Ten minutes.
2. A one-day trial, with no contract change: Codex in a test container under gVisor, behind the proxy, with a real key. It answers the "to test" rows above and measures memory.
3. Change the HLD, then `openapi.yaml`, then `vm.proto`, then the migrations.
4. The image stage, `codex.py`, the crew files, and tests with a fake `codex` program, as was done for Claude.
5. vm-manager and backend, then the web app.
6. A real run on the test server. This needs an OpenAI API key with a balance.

---

## 6. The other engines

**GitHub Copilot CLI: later, first in line.** Its licence says GitHub "grants you the right to reproduce and redistribute unmodified copies of the Software as part of an application or service", if the service does more than the program itself and the licence text is included. Use of GitHub's service stays under each user's own GitHub terms, which say "Your login may only be used by one person". Sign-in fits a container: the docs say headless machines "default to the device code flow", with the code typed at `github.com/login/device`. It has MCP over HTTP and one file per custom agent. One plan gives the user OpenAI, Anthropic and Google models. The risk: the sign-in is a GitHub token, and our rule is that a container never holds one. The fix is a narrow token that the user makes with only the "Copilot Requests" permission. Not confirmed: its event stream, tool lists per helper, its hosts, and whether GitHub minds a third party hosting it. Size: medium.

**Gemini CLI: later, with an API key.** It is the closest to Claude Code in shape: a `stream-json` event stream, and sub-agents with a real tool list each, so all the crew's locks should hold. The catch is the sign-in. The docs say a Google sign-in "requires a web browser on a machine that can communicate with the terminal", and for headless use they point to an API key. I found no browserless Google sign-in. On terms, the docs forbid reaching Google's service "using third-party software", with the example "using OpenClaw with Gemini CLI OAuth". The unchanged program on our server is not named either way. So: build it for API keys, and ask Google before offering the Google sign-in. Size: medium.

**OpenCode: never.** It is an open-source program for many providers, which is what Hermes already is for us. Its ChatGPT sign-in falls under the same OpenAI rule as Codex. Its own docs say of Claude plans: "Anthropic explicitly prohibits this."

**Qwen Code: never.** Its free sign-in ended: "the free tier was discontinued on 2026-04-15". What is left is a key, and Hermes already takes Alibaba keys.

**Cursor CLI: never, unless Cursor agrees in writing.** It runs headless with a key. But it is closed software, and Cursor's terms (3 September 2026) say you may not "reproduce" the Service or "rent, lease, lend, or sell" it.

**Hermes' own subscription sign-ins: never on our servers.** Hermes can sign in with ChatGPT, Copilot, Grok and a Claude Max plan. Each is a third-party program on a subscription. Anthropic forbids that, and OpenAI's terms require the user's own machine.

---

## 7. API keys: the list for Hermes

Read from the Hermes docs inside the source at our pinned commit (28 September 2026). Today our backend accepts three: Anthropic, OpenAI, OpenRouter. And today the Bridge points Hermes only at our own gateway. How a key reaches Hermes is the other agent's work.

| Group | Providers Hermes takes with one key |
|---|---|
| Accepted by our backend today | Anthropic, OpenAI, OpenRouter |
| Good next ones | Google Gemini (**free tier, no card**), DeepSeek, xAI (Grok), Hugging Face, NVIDIA, Fireworks |
| Chinese providers | z.ai (GLM), Kimi (Moonshot), MiniMax, Alibaba (Qwen, Coding Plan, Token Plan), Xiaomi, Tencent, StepFun |
| Gateways and others | Vercel AI Gateway, Novita, Nebius, Arcee, GMI Cloud, Ollama Cloud, OpenCode Zen and Go, Kilo Code, CommandCode, Ramp Router |
| Any OpenAI-compatible address | "Custom endpoint": Groq, Together and similar, with an address and a key |
| Need more than a key: later | AWS Bedrock, Google Vertex AI, Azure AI Foundry |

Each provider is one more host on the way out, or one more model behind our gateway. A free Gemini key runs out fast: Hermes' docs warn that such keys "can be exhausted after a handful of agent turns".

---

## 8. One change that makes every new engine cheaper

Today "Claude" is written into the contracts by name: three gRPC calls, three REST paths, two database columns, one fixed list of two engines. A copy for Codex, then for Copilot, then for Gemini, would triple all of it.

I propose to make it generic once, as in 5.9: an engine is an id in a list, and sign-in is four calls that take the engine's id. Claude Code becomes the first entry. After that a new engine is an image stage, one Bridge module and one line in a list.

---

## 9. Risks

| Risk | What it means | What to do |
|---|---|---|
| OpenAI's terms | Offering ChatGPT plans without approval can get our users' accounts closed and us blocked | Do not ship it. Send the form |
| A wide door out | `api.openai.com` and `chatgpt.com` are large public services. The proxy sees only the host name. A tricked agent could send data to another OpenAI account, or read a shared chat as if it were instructions. The same is true for Anthropic's hosts today. For Copilot the host is `api.github.com` | Keep these hosts open only while that engine runs. Accept it as a known limit, or pay for a proxy that reads paths (large work) |
| Weaker locks on Codex | Scout keeps a shell. Patch can write | Strict page reading, cached search, a "beta" label. Try the hook idea in the trial |
| The sign-in file in the container | The agent has a shell and can read it. Same as Claude today | Only the user's own account is at stake. Say so on the settings screen |
| Fast releases | Codex shipped 0.161.0 yesterday. Its docs changed address this year. Event names and settings may change | Pin the version. Raise it on purpose, with the tests |
| Memory | Hermes starts in every container, even when another engine answers | Decide finding 1 of HLD section 12 before adding a third engine |
| Testing | An OpenAI key needs a card with a balance | Borrow one key for the real run. Test the generic contracts on Claude first |
| Automations on a plan | If ChatGPT plans come, a reminder or a pull-request review uses the plan with no user present | Ask OpenAI about background use in the same letter |

---

## 10. Decisions for you

1. **Send OpenAI the Sign in with ChatGPT form now?** Yes or no. **I recommend yes.** It is free and it is the only road to ChatGPT plans. Say in it that each user has their own container, and ask about background use and about charging for container time.
2. **Build Codex now with an API key only, or wait for OpenAI?** (a) Build now. (b) Do only the one-day trial and the generic contracts now, build the rest later. (c) Wait. **I recommend (b) before the beta and (a) right after it.** With a key, Codex gives a user little that Hermes with the same key does not give, except OpenAI's own program and free search.
3. **Generic contracts, or a copy per engine?** **I recommend generic** (section 8). It changes existing contracts once, by additions only.
4. **Weaker locks on Codex: accept them?** (a) Accept, with the strict rules and a beta label. (b) Offer Codex without the crew. (c) Do not offer Codex until the locks hold. **I recommend (a), decided after the trial.**
5. **Copilot: device sign-in or a pasted narrow token?** The device sign-in is easier for the user but puts a GitHub token in the container. **I recommend the narrow token**, stored encrypted like an API key.
6. **Gemini: API key only, or also Google sign-in?** **I recommend key only** until Google answers and a sign-in without a browser is proven.
7. **Which key providers to add to Hermes first?** **I recommend Gemini** (free to test), then DeepSeek and xAI.
8. **Should Hermes stop starting when another engine is chosen?** This is the open finding 1. **I recommend yes**, before a third engine goes in.

---

## 11. The ranked list

**Now**

1. **Hermes with more key providers.** No new engine. It is what "every API key" means. Gemini's free key lets you test with no card.
2. **Codex CLI with an OpenAI API key.** You asked for it. It is allowed, it is nearly a twin of the Claude engine, and it is ready for ChatGPT plans on the day OpenAI agrees. Start with the one-day trial and the generic contracts.

**Later**

3. **GitHub Copilot CLI.** The only other subscription whose licence allows shipping the program inside a service. Needs a short trial and one question to GitHub.
4. **Gemini CLI with an API key.** The best fit for the crew's locks. Google sign-in only after Google answers.
5. **ChatGPT plans on Codex.** Only after OpenAI's yes.

**Never**

6. **OpenCode.** It repeats Hermes, and its ChatGPT sign-in is under the same rule.
7. **Qwen Code.** Its free sign-in ended in April 2026. A key works in Hermes.
8. **Cursor CLI.** Closed software. Its terms forbid copying it.
9. **Hermes' built-in subscription sign-ins.** Forbidden by Anthropic, and by OpenAI for a hosted service.

---

## 12. What I could not confirm, and the sources

**Not confirmed**

- Whether Codex's inner sandbox (bubblewrap) runs under gVisor. Not tested.
- Whether a Codex agent file can turn search on for Scout only, turn helpers off for a specialist, or carry its own hook. The docs say the file is "configuration layers". Not tested.
- How a sub-agent's start and end appear in `codex exec --json`. The docs list the item types and none is for sub-agents.
- The full list of hosts for Codex on a ChatGPT plan.
- The terms OpenAI gives an approved hosted partner. Not public.
- OpenAI's live policy pages. They refused my reader, so I used saved copies, dated above.
- Gemini: a Google sign-in with no browser on the machine. I did not read the Gemini API terms page.
- Copilot: the event stream, tool lists per custom agent, the hosts, the rights carried by the device sign-in's token, and GitHub's view on hosting.
- Cursor: I read only its terms and two CLI pages.
- Memory and disk use of each program in our container.

**Pages opened** (8 October 2026)

- Codex docs, at `learn.chatgpt.com/docs/…`: `auth`, `non-interactive-mode`, `sandboxing`, `agent-approvals-security`, `extend/mcp`, `agent-configuration/subagents`, `hooks`, `web-search`, `app-server`, `codex-sdk`, `codex/cli`, `pricing`, `open-source`, `config-file/config-reference`, `config-file/environment-variables`, `developer-commands?surface=cli`. `developers.openai.com/codex/…` now forwards there.
- Sign in with ChatGPT: `developers.openai.com/siwc` (all pages, through `llms-full.txt`), `developers.openai.com/cookbook/articles/sign-in-with-chatgpt`.
- OpenAI policies, saved copies: `openai.com/policies/sign-in-with-chatgpt-terms/` (7 Oct 2026), `openai.com/policies/service-terms/` (6 Oct 2026), `openai.com/policies/terms-of-use/` (31 Aug 2026).
- Versions: `api.github.com/repos/openai/codex/releases/latest`, and the npm registry for `@openai/codex`, `@google/gemini-cli`, `@github/copilot`, `@qwen-code/qwen-code`, `opencode-ai`.
- Gemini CLI, in `github.com/google-gemini/gemini-cli`: `docs/get-started/authentication.mdx`, `docs/cli/headless.md`, `docs/core/subagents.md`, `docs/resources/tos-privacy.md`, `docs/resources/quota-and-pricing.md`, `docs/reference/configuration.md`.
- GitHub Copilot CLI, at `docs.github.com/en/copilot/how-tos/copilot-cli/…`: `automate-copilot-cli/run-cli-programmatically`, `set-up-copilot-cli/authenticate-copilot-cli`, `customize-copilot/create-custom-agents-for-cli`, `customize-copilot/add-mcp-servers`. Also the licence file in the npm package `@github/copilot@1.0.93`, the GitHub Terms of Service (in force 27 April 2026) and the GitHub Terms for Additional Products and Features.
- OpenCode: `opencode.ai/docs/providers/`, `/docs/cli/`, `/docs/agents/`.
- Qwen Code, in `github.com/QwenLM/qwen-code`: `README.md`, `docs/users/configuration/auth.md`.
- Cursor: `cursor.com/docs/cli/headless.md`, `cursor.com/docs/cli/reference/authentication.md`, `cursor.com/terms-of-service`.
- Hermes at commit `35272ce` (`github.com/NousResearch/hermes-agent`): `website/docs/integrations/providers.md`, `plugins/model-providers/`.
