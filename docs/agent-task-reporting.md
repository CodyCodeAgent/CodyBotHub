# AI Hub task reporting

For workspaces containing the AI Hub `agent-task-lifecycle` canonical Python CLI,
CodyBotHub exposes `codybothub.agent_task`. This is a managed adapter to that CLI,
not a second registration API. Runtime tool contract version 3 migrates older
threads when the workspace capability is installed.

Each invocation binds app ID from the routed Bot, chat and current message from
the verified inbound Feishu event, and session from the Thread Channel. Neither
model arguments nor user text may override those values. Independent subprocess
environments and client ledgers keep concurrent conversations separate. Existing
round commands validate the stored app/chat/session before accessing the round.

The host supplies `AGENT_TASK_COLLECTOR_URL` and `AGENT_TASK_COLLECTOR_TOKEN` from
its private service environment. The token must have at least 32 characters. Use
the existing collector deployment procedure in AI Hub `docs/agent-task-collector.md`.
Only the collector has Base access. Client workspaces must use collector transport;
the adapter refuses direct Base fallback. Do not copy tokens or personal profiles
into workspace configuration. Missing configuration is an explicit error.
The shared engine environment removes collector credentials and BotMux identity;
only the managed reporting child receives the current message's compatibility
environment.

Registration follows status → name preview → explicit user confirmation. Merely
loading the skill or previewing a name never registers the bot. Registration
conversations do not create task facts. Normal unregistered conversations do not
query the registration service or ask for a name. `start` returning `skipped`
ends telemetry work for that message. Only actual Base receipts prove reporting.

CodyBotHub owns Feishu delivery. This adapter never invokes BotMux `--notify`,
`--send`, or `feedback-send`, so it cannot duplicate the platform reply.
The canonical Python module is loaded with its sibling module path to support
AI Hub checkouts whose old compatibility entry cannot import registration.
