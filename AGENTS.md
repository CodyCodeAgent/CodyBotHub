# CodyBotHub contributor guide

- Keep CodyBotHub product entities in this repository. Transport and Codex primitives that are reusable by other products belong in CodyWebCore.
- Native Codex history is the conversation source of truth. Store routing metadata and Core thread references, not a second transcript.
- Every Bot must have a default Workspace. Every Scene must use a Workspace attached to its Bot.
- Never return stored Feishu secrets from read APIs.
- Use parameterized SQLite statements and keep foreign keys enabled.
- Run `pnpm check` before handing off a completed change.
