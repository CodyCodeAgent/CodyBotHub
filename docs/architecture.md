# CodyBotHub architecture

## Boundaries

CodyBotHub owns the management product and its domain entities: Workspace, Bot, Scene, Skill Package, group binding, topic routing context, provisioning job and conversation thread mapping. CodyWebCore remains the single owner of Codex protocol, session lifecycle, normalized conversation events and provider-neutral channel primitives.

Feishu message parsing, cards, WebSocket lifecycle and delivery calls use `@codycodeagent/cody-web-core/feishu`. CodyBotHub adds only product routing and policy.

## Data flow

1. `FeishuProvider` converts a Feishu event into `ChannelInboundMessage`.
2. The SQLite inbox claim deduplicates `bot_id + message_id`, so Feishu retries with a new event id remain idempotent across restarts. Claims expire after the provider retry window.
3. The Bot conversation mode derives the Thread identity from the chat, or from the chat plus topic root.
4. The router checks specific enabled Scene matchers, an inherited topic routing context, a saved group default, and finally a matcher-free fallback Scene. The selected Scene chooses the Workspace; no Scene uses the Bot default Workspace.
5. CodyBotHub composes system instructions in this exact order:

   ```text
   Platform base Prompt
   + Workspace Prompt
   + Bot Prompt
   + Scene Prompt
   + Skill Package Prompt(s)
   ```

6. The composed instructions are supplied as trusted per-turn application context. `CodexSessionManager` creates or resumes the native Codex Thread, while the selected Workspace becomes that turn’s cwd and runtime root. CodyBotHub stores only the conversation key and native Thread id; native Codex history remains the transcript source of truth.
7. Messages sharing one chat/topic anchor are serialized before entering Codex; unrelated conversations still run concurrently.
8. The final Core Turn outcome is replied as one or more Feishu Markdown cards. The Bot conversation mode selects direct or topic reply. Every card carries a footer with the effective Workspace, Scene, Skill Package and permission policy.

## Model selection

Model and reasoning effort are resolved independently for every message in this order: Scene override, Bot override, platform default, then the current Codex account default. The model list and supported reasoning efforts come from CodyWebCore at runtime rather than from a hard-coded catalog.

The resolved values are passed on the Core Turn and do not participate in Thread identity. If an option disappears from the account catalog, the platform fallback policy either selects the Codex default or rejects the turn. Message logs store the actual model, reasoning effort, source level and fallback state for later diagnosis.

## Matching

Scene matcher fields are ANDed across populated categories and ORed within each category:

- `chatIds`: exact Chat ID
- `messageTypes`: exact normalized message type
- `textIncludes`: case-insensitive substring
- `cardTitleIncludes`: case-insensitive substring against normalized post/card title

An empty category does not restrict the match. The first specifically matching scene in deterministic priority order wins. In topic mode, later addressed messages can inherit the most recent specifically matched Scene for that topic. A group binding is the group default, while a Scene with no matcher is the final Bot-level fallback.

App-authored messages are accepted only when their content independently matches a Scene. A saved group binding does not make arbitrary bot output executable. This supports alert cards while preventing reply loops.

A card selection creates a `group_scene_bindings` row. A bound scene supplies the group default until changed or deleted; a more specific message matcher can override it for the current message and topic routing context.

## Thread identity

Thread identity is controlled only by the Bot conversation mode:

- Chat mode: `Bot + Chat`
- Topic mode: `Bot + Chat + topic root`
- Private conversations always use `Bot + Chat`

Scene, Workspace and Skill Package never participate in the conversation key. The same Thread can therefore process turns through different Scenes while retaining one native Codex history. A topic routing context may remember the most recent specifically matched Scene for later follow-ups, but it does not own or split the Thread.

## Unknown groups

An addressed message in a group without a matched or bound Scene is submitted immediately in the Bot default Workspace. CodyBotHub also replies with a Scene picker once when the group is first encountered. Selecting a Scene sets the group default, affects later messages and does not replay the first message.

Unaddressed group messages are ignored unless an enabled or bound Scene matches them. This allows alert cards to trigger automation without making the Bot answer every message in an unconfigured group.

## Skill Packages

A Skill Package belongs to one Workspace. A Scene can attach only packages from its own Workspace. Local Skill references resolve from:

- `.agents/skills/<name>/SKILL.md`
- `.codex/skills/<name>/SKILL.md`
- `skills/<name>/SKILL.md`
- an explicit absolute `SKILL.md` path

The package policy is also expressed in the Turn prompt so `package_first`, `mixed` and `package_only` remain visible to the model. Resolved local Skills are sent as native Core skill inputs.

## Security

- The first launch creates one administrator password hashed with Argon2id.
- Login sessions use random 256-bit tokens; SQLite stores only SHA-256 token digests.
- Cookies are `HttpOnly` and `SameSite=Lax`; state-changing requests reject cross-origin origins.
- Feishu App Secrets are encrypted using AES-256-GCM with a local 0600 master key.
- List APIs never return App Secrets.
- Workspace paths must already exist and be directories.
- Bot turns run in YOLO mode: `approvalPolicy: never` with Core `dangerFullAccess`, including network and tool access. The selected Workspace remains the turn cwd and routing boundary.

## Feishu application provisioning

Automatic registration follows botmux's Device Flow use of `@larksuiteoapi/node-sdk/registerApp`. A persisted job exposes the QR URL and status; the returned secret is encrypted directly into the Bot record and never placed in the job or API response.

The Device Flow creates a Personal Agent application. Tenant-specific permission approval may still be required in the Feishu Open Platform before the Bot can receive every message type. Existing applications can be adopted by entering App ID and App Secret.

The shared provider resolves `nonsupport` and reduced interactive-card events through the message-detail API, retries exhausted WebSocket connections, normalizes inline rich-text mentions and resources, and downloads attachments with bounded size and safe local names.

## Process lifecycle

- One process owns one shared `AppServerHost` and `CodexSessionManager`.
- Configured Bots each own one Core `FeishuProvider` connection.
- Editing credentials reloads the affected providers.
- In-progress Device Flow jobs are marked failed after a process restart because the remote poll cannot be resumed safely; users can start a new job.
