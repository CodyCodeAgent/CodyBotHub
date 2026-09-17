# CodyBotHub architecture

## Boundaries

CodyBotHub owns the management product and its domain entities: Workspace, Bot, Scene, Skill Package, group binding, provisioning job and conversation route. CodyWebCore remains the single owner of Codex protocol, session lifecycle, normalized conversation events and provider-neutral channel primitives.

Feishu message parsing, cards, WebSocket lifecycle and delivery calls use `@codycodeagent/cody-web-core/feishu`. CodyBotHub adds only product routing and policy.

## Data flow

1. `FeishuProvider` converts a Feishu event into `ChannelInboundMessage`.
2. The SQLite inbox claim deduplicates `bot_id + message_id`, so Feishu retries with a new event id remain idempotent across restarts. Claims expire after the provider retry window.
3. The router checks a saved group binding, then enabled scenes ordered by `priority ASC, name ASC`.
4. A matched scene chooses its configured Workspace. No match uses the Bot default Workspace.
5. CodyBotHub composes system instructions in this exact order:

   ```text
   Platform base Prompt
   + Workspace Prompt
   + Bot Prompt
   + Scene Prompt
   + Skill Package Prompt(s)
   ```

6. `CodexSessionManager` creates or resumes the native Codex Thread. CodyBotHub stores only the routing key and native Thread id; native Codex history remains the transcript source of truth.
7. Messages sharing one chat/topic anchor are serialized before entering Codex; unrelated conversations still run concurrently.
8. The final Core Turn outcome is replied as one or more Feishu Markdown cards. Scene or Bot configuration selects direct or topic reply. Every card carries a footer with the effective Workspace, Scene, Skill Package and permission policy.

## Matching

Scene matcher fields are ANDed across populated categories and ORed within each category:

- `chatIds`: exact Chat ID
- `messageTypes`: exact normalized message type
- `textIncludes`: case-insensitive substring
- `cardTitleIncludes`: case-insensitive substring against normalized post/card title

An empty category does not restrict the match. The first matching scene in deterministic priority order wins.

App-authored messages are accepted only when their content independently matches a Scene. A saved group binding does not make arbitrary bot output executable. This supports alert cards while preventing reply loops.

A card selection creates a `group_scene_bindings` row. A bound scene wins over automatic matching until changed or deleted.

## Thread identity

- Matched Scene: `Bot + Scene + Chat`
- No Scene, normal reply: `Bot + Chat`
- No Scene, topic reply: `Bot + Chat + topic root`

Including Chat in a reusable Scene key prevents conversation history from leaking between groups while keeping one stable Thread for that Scene inside a group.

## Unknown groups

An addressed message in a group without a matched or bound Scene is submitted immediately in the Bot default Workspace. CodyBotHub also replies with a Scene picker. Selecting a Scene affects later messages and does not replay the first message.

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
