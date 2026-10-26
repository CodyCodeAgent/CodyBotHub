import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from './persistence/migrations.js'
import { migrateLegacySchema } from './persistence/legacy-baseline.js'
import { migrateScheduledSchema } from './persistence/scheduled-schema.js'
import { AdminRepository } from './persistence/admin-repository.js'
import { AuditRepository } from './persistence/audit-repository.js'
import { WorkspaceRepository } from './persistence/workspace-repository.js'
import { SkillSourceRepository } from './persistence/skill-source-repository.js'
import { ProvisioningRepository } from './persistence/provisioning-repository.js'
import { HubTaskRepository } from './persistence/hub-task-repository.js'
import { BotSceneRepository } from './persistence/bot-scene-repository.js'
import { ToolCatalogRepository } from './persistence/tool-catalog-repository.js'
import { CopilotRepository } from './persistence/copilot-repository.js'
import { PlatformSettingsRepository } from './persistence/platform-settings-repository.js'
import { StoreReadModel } from './persistence/store-read-model.js'
import { ConversationRepository } from './persistence/conversation-repository.js'

export class HubStore {
  readonly db: DatabaseSync

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true })
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.migrate()
    this.accounts = new AdminRepository(this.db)
    this.audit = new AuditRepository(this.db)
    this.workspaces = new WorkspaceRepository(this.db)
    this.copilot = new CopilotRepository(this.db, this.accounts, this.workspaces)
    this.settings = new PlatformSettingsRepository(this.db)
    this.readModel = new StoreReadModel(this.db)
    this.skillSources = new SkillSourceRepository(this.db, this.workspaces)
    this.provisioning = new ProvisioningRepository(this.db)
    this.hubTasks = new HubTaskRepository(this.db)
    this.botScenes = new BotSceneRepository(this.db)
    this.toolCatalog = new ToolCatalogRepository(this.db, this.botScenes)
    this.conversation = new ConversationRepository(this.db, { botScenes: this.botScenes, workspaces: this.workspaces, toolCatalog: this.toolCatalog, settings: this.settings, audit: this.audit, hubTasks: this.hubTasks })
  }

  close(): void { this.db.close() }

  readonly recoverInterruptedToolExecutions = (...args: Parameters<ToolCatalogRepository['recoverInterruptedToolExecutions']>): ReturnType<ToolCatalogRepository['recoverInterruptedToolExecutions']> => this.toolCatalog.recoverInterruptedToolExecutions(...args)

  private migrate(): void {
    applyMigrations(this.db, [
      { version: 1, name: 'legacy-baseline', up: migrateLegacySchema },
      { version: 2, name: 'scheduled-schema', up: migrateScheduledSchema },
    ])
  }

  readonly accounts: AdminRepository
  readonly hasAdmin = (...args: Parameters<AdminRepository['hasAdmin']>): ReturnType<AdminRepository['hasAdmin']> => this.accounts.hasAdmin(...args)
  readonly listAdminAccounts = (...args: Parameters<AdminRepository['listAdminAccounts']>): ReturnType<AdminRepository['listAdminAccounts']> => this.accounts.listAdminAccounts(...args)
  readonly getAdminAccount = (...args: Parameters<AdminRepository['getAdminAccount']>): ReturnType<AdminRepository['getAdminAccount']> => this.accounts.getAdminAccount(...args)
  readonly findAdminAccountByLogin = (...args: Parameters<AdminRepository['findAdminAccountByLogin']>): ReturnType<AdminRepository['findAdminAccountByLogin']> => this.accounts.findAdminAccountByLogin(...args)
  readonly createAdminAccount = (...args: Parameters<AdminRepository['createAdminAccount']>): ReturnType<AdminRepository['createAdminAccount']> => this.accounts.createAdminAccount(...args)
  readonly updateAdminAccount = (...args: Parameters<AdminRepository['updateAdminAccount']>): ReturnType<AdminRepository['updateAdminAccount']> => this.accounts.updateAdminAccount(...args)
  readonly deleteAdminAccount = (...args: Parameters<AdminRepository['deleteAdminAccount']>): ReturnType<AdminRepository['deleteAdminAccount']> => this.accounts.deleteAdminAccount(...args)
  readonly touchAdminLogin = (...args: Parameters<AdminRepository['touchAdminLogin']>): ReturnType<AdminRepository['touchAdminLogin']> => this.accounts.touchAdminLogin(...args)
  readonly setAdminTheme = (...args: Parameters<AdminRepository['setAdminTheme']>): ReturnType<AdminRepository['setAdminTheme']> => this.accounts.setAdminTheme(...args)
  readonly createSession = (...args: Parameters<AdminRepository['createSession']>): ReturnType<AdminRepository['createSession']> => this.accounts.createSession(...args)
  readonly hasSession = (...args: Parameters<AdminRepository['hasSession']>): ReturnType<AdminRepository['hasSession']> => this.accounts.hasSession(...args)
  readonly getSessionAccount = (...args: Parameters<AdminRepository['getSessionAccount']>): ReturnType<AdminRepository['getSessionAccount']> => this.accounts.getSessionAccount(...args)
  readonly deleteSession = (...args: Parameters<AdminRepository['deleteSession']>): ReturnType<AdminRepository['deleteSession']> => this.accounts.deleteSession(...args)

  readonly audit: AuditRepository
  readonly createAuditLog = (...args: Parameters<AuditRepository['createAuditLog']>): ReturnType<AuditRepository['createAuditLog']> => this.audit.createAuditLog(...args)
  readonly listAuditLogs = (...args: Parameters<AuditRepository['listAuditLogs']>): ReturnType<AuditRepository['listAuditLogs']> => this.audit.listAuditLogs(...args)
  readonly getAuditLog = (...args: Parameters<AuditRepository['getAuditLog']>): ReturnType<AuditRepository['getAuditLog']> => this.audit.getAuditLog(...args)

  readonly copilot: CopilotRepository
  readonly getOrCreateCopilotSession = (...args: Parameters<CopilotRepository['getOrCreateCopilotSession']>): ReturnType<CopilotRepository['getOrCreateCopilotSession']> => this.copilot.getOrCreateCopilotSession(...args)
  readonly getCopilotSession = (...args: Parameters<CopilotRepository['getCopilotSession']>): ReturnType<CopilotRepository['getCopilotSession']> => this.copilot.getCopilotSession(...args)
  readonly resetCopilotSession = (...args: Parameters<CopilotRepository['resetCopilotSession']>): ReturnType<CopilotRepository['resetCopilotSession']> => this.copilot.resetCopilotSession(...args)
  readonly setCopilotCoreThread = (...args: Parameters<CopilotRepository['setCopilotCoreThread']>): ReturnType<CopilotRepository['setCopilotCoreThread']> => this.copilot.setCopilotCoreThread(...args)
  readonly setCopilotToolContractVersion = (...args: Parameters<CopilotRepository['setCopilotToolContractVersion']>): ReturnType<CopilotRepository['setCopilotToolContractVersion']> => this.copilot.setCopilotToolContractVersion(...args)
  readonly addCopilotMessage = (...args: Parameters<CopilotRepository['addCopilotMessage']>): ReturnType<CopilotRepository['addCopilotMessage']> => this.copilot.addCopilotMessage(...args)
  readonly listCopilotMessages = (...args: Parameters<CopilotRepository['listCopilotMessages']>): ReturnType<CopilotRepository['listCopilotMessages']> => this.copilot.listCopilotMessages(...args)
  readonly createCopilotProposal = (...args: Parameters<CopilotRepository['createCopilotProposal']>): ReturnType<CopilotRepository['createCopilotProposal']> => this.copilot.createCopilotProposal(...args)
  readonly listCopilotProposals = (...args: Parameters<CopilotRepository['listCopilotProposals']>): ReturnType<CopilotRepository['listCopilotProposals']> => this.copilot.listCopilotProposals(...args)
  readonly getCopilotProposal = (...args: Parameters<CopilotRepository['getCopilotProposal']>): ReturnType<CopilotRepository['getCopilotProposal']> => this.copilot.getCopilotProposal(...args)
  readonly finishCopilotProposal = (...args: Parameters<CopilotRepository['finishCopilotProposal']>): ReturnType<CopilotRepository['finishCopilotProposal']> => this.copilot.finishCopilotProposal(...args)

  readonly settings: PlatformSettingsRepository
  readonly getPlatformSettings = (...args: Parameters<PlatformSettingsRepository['getPlatformSettings']>): ReturnType<PlatformSettingsRepository['getPlatformSettings']> => this.settings.getPlatformSettings(...args)
  readonly getPlatformPrompt = (...args: Parameters<PlatformSettingsRepository['getPlatformPrompt']>): ReturnType<PlatformSettingsRepository['getPlatformPrompt']> => this.settings.getPlatformPrompt(...args)
  readonly setPlatformPrompt = (...args: Parameters<PlatformSettingsRepository['setPlatformPrompt']>): ReturnType<PlatformSettingsRepository['setPlatformPrompt']> => this.settings.setPlatformPrompt(...args)
  readonly setPlatformSettings = (...args: Parameters<PlatformSettingsRepository['setPlatformSettings']>): ReturnType<PlatformSettingsRepository['setPlatformSettings']> => this.settings.setPlatformSettings(...args)

  readonly workspaces: WorkspaceRepository
  readonly listWorkspaces = (...args: Parameters<WorkspaceRepository['listWorkspaces']>): ReturnType<WorkspaceRepository['listWorkspaces']> => this.workspaces.listWorkspaces(...args)
  readonly createWorkspace = (...args: Parameters<WorkspaceRepository['createWorkspace']>): ReturnType<WorkspaceRepository['createWorkspace']> => this.workspaces.createWorkspace(...args)
  readonly updateWorkspace = (...args: Parameters<WorkspaceRepository['updateWorkspace']>): ReturnType<WorkspaceRepository['updateWorkspace']> => this.workspaces.updateWorkspace(...args)
  readonly deleteWorkspace = (...args: Parameters<WorkspaceRepository['deleteWorkspace']>): ReturnType<WorkspaceRepository['deleteWorkspace']> => this.workspaces.deleteWorkspace(...args)
  readonly getWorkspace = (...args: Parameters<WorkspaceRepository['getWorkspace']>): ReturnType<WorkspaceRepository['getWorkspace']> => this.workspaces.getWorkspace(...args)

  readonly skillSources: SkillSourceRepository
  readonly listSkillSources = (...args: Parameters<SkillSourceRepository['listSkillSources']>): ReturnType<SkillSourceRepository['listSkillSources']> => this.skillSources.listSkillSources(...args)
  readonly getSkillSource = (...args: Parameters<SkillSourceRepository['getSkillSource']>): ReturnType<SkillSourceRepository['getSkillSource']> => this.skillSources.getSkillSource(...args)
  readonly createSkillSource = (...args: Parameters<SkillSourceRepository['createSkillSource']>): ReturnType<SkillSourceRepository['createSkillSource']> => this.skillSources.createSkillSource(...args)
  readonly updateSkillSource = (...args: Parameters<SkillSourceRepository['updateSkillSource']>): ReturnType<SkillSourceRepository['updateSkillSource']> => this.skillSources.updateSkillSource(...args)
  readonly deleteSkillSource = (...args: Parameters<SkillSourceRepository['deleteSkillSource']>): ReturnType<SkillSourceRepository['deleteSkillSource']> => this.skillSources.deleteSkillSource(...args)
  readonly updateSkillSourceSync = (...args: Parameters<SkillSourceRepository['updateSkillSourceSync']>): ReturnType<SkillSourceRepository['updateSkillSourceSync']> => this.skillSources.updateSkillSourceSync(...args)
  readonly listSkillInstallations = (...args: Parameters<SkillSourceRepository['listSkillInstallations']>): ReturnType<SkillSourceRepository['listSkillInstallations']> => this.skillSources.listSkillInstallations(...args)
  readonly upsertSkillInstallation = (...args: Parameters<SkillSourceRepository['upsertSkillInstallation']>): ReturnType<SkillSourceRepository['upsertSkillInstallation']> => this.skillSources.upsertSkillInstallation(...args)

  readonly botScenes: BotSceneRepository
  readonly listBots = (...args: Parameters<BotSceneRepository['listBots']>): ReturnType<BotSceneRepository['listBots']> => this.botScenes.listBots(...args)
  readonly createBot = (...args: Parameters<BotSceneRepository['createBot']>): ReturnType<BotSceneRepository['createBot']> => this.botScenes.createBot(...args)
  readonly updateBot = (...args: Parameters<BotSceneRepository['updateBot']>): ReturnType<BotSceneRepository['updateBot']> => this.botScenes.updateBot(...args)
  readonly deleteBot = (...args: Parameters<BotSceneRepository['deleteBot']>): ReturnType<BotSceneRepository['deleteBot']> => this.botScenes.deleteBot(...args)
  readonly listScenes = (...args: Parameters<BotSceneRepository['listScenes']>): ReturnType<BotSceneRepository['listScenes']> => this.botScenes.listScenes(...args)
  readonly createScene = (...args: Parameters<BotSceneRepository['createScene']>): ReturnType<BotSceneRepository['createScene']> => this.botScenes.createScene(...args)
  readonly updateScene = (...args: Parameters<BotSceneRepository['updateScene']>): ReturnType<BotSceneRepository['updateScene']> => this.botScenes.updateScene(...args)
  readonly deleteScene = (...args: Parameters<BotSceneRepository['deleteScene']>): ReturnType<BotSceneRepository['deleteScene']> => this.botScenes.deleteScene(...args)
  readonly toolCatalog: ToolCatalogRepository
  readonly listSkillPackages = (...args: Parameters<ToolCatalogRepository['listSkillPackages']>): ReturnType<ToolCatalogRepository['listSkillPackages']> => this.toolCatalog.listSkillPackages(...args)
  readonly createSkillPackage = (...args: Parameters<ToolCatalogRepository['createSkillPackage']>): ReturnType<ToolCatalogRepository['createSkillPackage']> => this.toolCatalog.createSkillPackage(...args)
  readonly updateSkillPackage = (...args: Parameters<ToolCatalogRepository['updateSkillPackage']>): ReturnType<ToolCatalogRepository['updateSkillPackage']> => this.toolCatalog.updateSkillPackage(...args)
  readonly deleteSkillPackage = (...args: Parameters<ToolCatalogRepository['deleteSkillPackage']>): ReturnType<ToolCatalogRepository['deleteSkillPackage']> => this.toolCatalog.deleteSkillPackage(...args)
  readonly listTools = (...args: Parameters<ToolCatalogRepository['listTools']>): ReturnType<ToolCatalogRepository['listTools']> => this.toolCatalog.listTools(...args)
  readonly getTool = (...args: Parameters<ToolCatalogRepository['getTool']>): ReturnType<ToolCatalogRepository['getTool']> => this.toolCatalog.getTool(...args)
  readonly createTool = (...args: Parameters<ToolCatalogRepository['createTool']>): ReturnType<ToolCatalogRepository['createTool']> => this.toolCatalog.createTool(...args)
  readonly updateTool = (...args: Parameters<ToolCatalogRepository['updateTool']>): ReturnType<ToolCatalogRepository['updateTool']> => this.toolCatalog.updateTool(...args)
  readonly deleteTool = (...args: Parameters<ToolCatalogRepository['deleteTool']>): ReturnType<ToolCatalogRepository['deleteTool']> => this.toolCatalog.deleteTool(...args)
  readonly listToolScriptVersions = (...args: Parameters<ToolCatalogRepository['listToolScriptVersions']>): ReturnType<ToolCatalogRepository['listToolScriptVersions']> => this.toolCatalog.listToolScriptVersions(...args)
  readonly listToolPackages = (...args: Parameters<ToolCatalogRepository['listToolPackages']>): ReturnType<ToolCatalogRepository['listToolPackages']> => this.toolCatalog.listToolPackages(...args)
  readonly getToolPackage = (...args: Parameters<ToolCatalogRepository['getToolPackage']>): ReturnType<ToolCatalogRepository['getToolPackage']> => this.toolCatalog.getToolPackage(...args)
  readonly createToolPackage = (...args: Parameters<ToolCatalogRepository['createToolPackage']>): ReturnType<ToolCatalogRepository['createToolPackage']> => this.toolCatalog.createToolPackage(...args)
  readonly updateToolPackage = (...args: Parameters<ToolCatalogRepository['updateToolPackage']>): ReturnType<ToolCatalogRepository['updateToolPackage']> => this.toolCatalog.updateToolPackage(...args)
  readonly deleteToolPackage = (...args: Parameters<ToolCatalogRepository['deleteToolPackage']>): ReturnType<ToolCatalogRepository['deleteToolPackage']> => this.toolCatalog.deleteToolPackage(...args)
  readonly createToolPackageExecution = (...args: Parameters<ToolCatalogRepository['createToolPackageExecution']>): ReturnType<ToolCatalogRepository['createToolPackageExecution']> => this.toolCatalog.createToolPackageExecution(...args)
  readonly getToolPackageExecution = (...args: Parameters<ToolCatalogRepository['getToolPackageExecution']>): ReturnType<ToolCatalogRepository['getToolPackageExecution']> => this.toolCatalog.getToolPackageExecution(...args)
  readonly findToolPackageExecution = (...args: Parameters<ToolCatalogRepository['findToolPackageExecution']>): ReturnType<ToolCatalogRepository['findToolPackageExecution']> => this.toolCatalog.findToolPackageExecution(...args)
  readonly listToolPackageExecutions = (...args: Parameters<ToolCatalogRepository['listToolPackageExecutions']>): ReturnType<ToolCatalogRepository['listToolPackageExecutions']> => this.toolCatalog.listToolPackageExecutions(...args)
  readonly listQueuedToolPackageExecutions = (...args: Parameters<ToolCatalogRepository['listQueuedToolPackageExecutions']>): ReturnType<ToolCatalogRepository['listQueuedToolPackageExecutions']> => this.toolCatalog.listQueuedToolPackageExecutions(...args)
  readonly updateToolPackageExecution = (...args: Parameters<ToolCatalogRepository['updateToolPackageExecution']>): ReturnType<ToolCatalogRepository['updateToolPackageExecution']> => this.toolCatalog.updateToolPackageExecution(...args)
  readonly transitionToolPackageExecution = (...args: Parameters<ToolCatalogRepository['transitionToolPackageExecution']>): ReturnType<ToolCatalogRepository['transitionToolPackageExecution']> => this.toolCatalog.transitionToolPackageExecution(...args)

  readonly readModel: StoreReadModel
  readonly dashboardDimensions = (...args: Parameters<StoreReadModel['dashboardDimensions']>): ReturnType<StoreReadModel['dashboardDimensions']> => this.readModel.dashboardDimensions(...args)
  readonly stats = (...args: Parameters<StoreReadModel['stats']>): ReturnType<StoreReadModel['stats']> => this.readModel.stats(...args)
  readonly systemHealth = (...args: Parameters<StoreReadModel['systemHealth']>): ReturnType<StoreReadModel['systemHealth']> => this.readModel.systemHealth(...args)

  readonly hubTasks: HubTaskRepository
  readonly createHubTask = (...args: Parameters<HubTaskRepository['createHubTask']>): ReturnType<HubTaskRepository['createHubTask']> => this.hubTasks.createHubTask(...args)
  readonly getHubTask = (...args: Parameters<HubTaskRepository['getHubTask']>): ReturnType<HubTaskRepository['getHubTask']> => this.hubTasks.getHubTask(...args)
  readonly findHubTask = (...args: Parameters<HubTaskRepository['findHubTask']>): ReturnType<HubTaskRepository['findHubTask']> => this.hubTasks.findHubTask(...args)
  readonly listHubTasks = (...args: Parameters<HubTaskRepository['listHubTasks']>): ReturnType<HubTaskRepository['listHubTasks']> => this.hubTasks.listHubTasks(...args)
  readonly latestHubTaskForSource = (...args: Parameters<HubTaskRepository['latestHubTaskForSource']>): ReturnType<HubTaskRepository['latestHubTaskForSource']> => this.hubTasks.latestHubTaskForSource(...args)
  readonly transitionHubTask = (...args: Parameters<HubTaskRepository['transitionHubTask']>): ReturnType<HubTaskRepository['transitionHubTask']> => this.hubTasks.transitionHubTask(...args)
  readonly updateHubTaskProgressForSource = (...args: Parameters<HubTaskRepository['updateHubTaskProgressForSource']>): ReturnType<HubTaskRepository['updateHubTaskProgressForSource']> => this.hubTasks.updateHubTaskProgressForSource(...args)

  readonly conversation: ConversationRepository
  readonly createMessageLog = (...args: Parameters<ConversationRepository['createMessageLog']>): ReturnType<ConversationRepository['createMessageLog']> => this.conversation.createMessageLog(...args)
  readonly acceptInboundMessage = (...args: Parameters<ConversationRepository['acceptInboundMessage']>): ReturnType<ConversationRepository['acceptInboundMessage']> => this.conversation.acceptInboundMessage(...args)
  readonly botReplyDepthFor = (...args: Parameters<ConversationRepository['botReplyDepthFor']>): ReturnType<ConversationRepository['botReplyDepthFor']> => this.conversation.botReplyDepthFor(...args)
  readonly recordOutboundMessage = (...args: Parameters<ConversationRepository['recordOutboundMessage']>): ReturnType<ConversationRepository['recordOutboundMessage']> => this.conversation.recordOutboundMessage(...args)
  readonly finishMessageLog = (...args: Parameters<ConversationRepository['finishMessageLog']>): ReturnType<ConversationRepository['finishMessageLog']> => this.conversation.finishMessageLog(...args)
  readonly setMessageLogModel = (...args: Parameters<ConversationRepository['setMessageLogModel']>): ReturnType<ConversationRepository['setMessageLogModel']> => this.conversation.setMessageLogModel(...args)
  readonly setMessageLogInvestigation = (...args: Parameters<ConversationRepository['setMessageLogInvestigation']>): ReturnType<ConversationRepository['setMessageLogInvestigation']> => this.conversation.setMessageLogInvestigation(...args)
  readonly setMessageLogThread = (...args: Parameters<ConversationRepository['setMessageLogThread']>): ReturnType<ConversationRepository['setMessageLogThread']> => this.conversation.setMessageLogThread(...args)
  readonly getThreadChannel = (...args: Parameters<ConversationRepository['getThreadChannel']>): ReturnType<ConversationRepository['getThreadChannel']> => this.conversation.getThreadChannel(...args)
  readonly setThreadChannelCoreThread = (...args: Parameters<ConversationRepository['setThreadChannelCoreThread']>): ReturnType<ConversationRepository['setThreadChannelCoreThread']> => this.conversation.setThreadChannelCoreThread(...args)
  readonly threadChannelMigrationContext = (...args: Parameters<ConversationRepository['threadChannelMigrationContext']>): ReturnType<ConversationRepository['threadChannelMigrationContext']> => this.conversation.threadChannelMigrationContext(...args)
  readonly enqueueThreadJob = (...args: Parameters<ConversationRepository['enqueueThreadJob']>): ReturnType<ConversationRepository['enqueueThreadJob']> => this.conversation.enqueueThreadJob(...args)
  readonly recoverInterruptedWork = (...args: Parameters<ConversationRepository['recoverInterruptedWork']>): ReturnType<ConversationRepository['recoverInterruptedWork']> => this.conversation.recoverInterruptedWork(...args)
  readonly listQueuedThreadJobs = (...args: Parameters<ConversationRepository['listQueuedThreadJobs']>): ReturnType<ConversationRepository['listQueuedThreadJobs']> => this.conversation.listQueuedThreadJobs(...args)
  readonly startThreadJob = (...args: Parameters<ConversationRepository['startThreadJob']>): ReturnType<ConversationRepository['startThreadJob']> => this.conversation.startThreadJob(...args)
  readonly finishThreadJob = (...args: Parameters<ConversationRepository['finishThreadJob']>): ReturnType<ConversationRepository['finishThreadJob']> => this.conversation.finishThreadJob(...args)
  readonly failThreadJob = (...args: Parameters<ConversationRepository['failThreadJob']>): ReturnType<ConversationRepository['failThreadJob']> => this.conversation.failThreadJob(...args)
  readonly setThreadJobReceiptReaction = (...args: Parameters<ConversationRepository['setThreadJobReceiptReaction']>): ReturnType<ConversationRepository['setThreadJobReceiptReaction']> => this.conversation.setThreadJobReceiptReaction(...args)
  readonly getThreadJob = (...args: Parameters<ConversationRepository['getThreadJob']>): ReturnType<ConversationRepository['getThreadJob']> => this.conversation.getThreadJob(...args)
  readonly listThreadJobs = (...args: Parameters<ConversationRepository['listThreadJobs']>): ReturnType<ConversationRepository['listThreadJobs']> => this.conversation.listThreadJobs(...args)
  readonly retryMessageLog = (...args: Parameters<ConversationRepository['retryMessageLog']>): ReturnType<ConversationRepository['retryMessageLog']> => this.conversation.retryMessageLog(...args)
  readonly listMessageAttempts = (...args: Parameters<ConversationRepository['listMessageAttempts']>): ReturnType<ConversationRepository['listMessageAttempts']> => this.conversation.listMessageAttempts(...args)
  readonly listThreadChannels = (...args: Parameters<ConversationRepository['listThreadChannels']>): ReturnType<ConversationRepository['listThreadChannels']> => this.conversation.listThreadChannels(...args)
  readonly listMessageLogs = (...args: Parameters<ConversationRepository['listMessageLogs']>): ReturnType<ConversationRepository['listMessageLogs']> => this.conversation.listMessageLogs(...args)
  readonly getMessageLog = (...args: Parameters<ConversationRepository['getMessageLog']>): ReturnType<ConversationRepository['getMessageLog']> => this.conversation.getMessageLog(...args)
  readonly getMessageLogForToolInvocation = (...args: Parameters<ConversationRepository['getMessageLogForToolInvocation']>): ReturnType<ConversationRepository['getMessageLogForToolInvocation']> => this.conversation.getMessageLogForToolInvocation(...args)
  readonly getMessageLogByBotMessage = (...args: Parameters<ConversationRepository['getMessageLogByBotMessage']>): ReturnType<ConversationRepository['getMessageLogByBotMessage']> => this.conversation.getMessageLogByBotMessage(...args)
  readonly latestMessageLogForThreadChannel = (...args: Parameters<ConversationRepository['latestMessageLogForThreadChannel']>): ReturnType<ConversationRepository['latestMessageLogForThreadChannel']> => this.conversation.latestMessageLogForThreadChannel(...args)
  readonly getBotSecret = (...args: Parameters<ConversationRepository['getBotSecret']>): ReturnType<ConversationRepository['getBotSecret']> => this.conversation.getBotSecret(...args)
  readonly bindGroupScene = (...args: Parameters<ConversationRepository['bindGroupScene']>): ReturnType<ConversationRepository['bindGroupScene']> => this.conversation.bindGroupScene(...args)
  readonly rememberTopicRoute = (...args: Parameters<ConversationRepository['rememberTopicRoute']>): ReturnType<ConversationRepository['rememberTopicRoute']> => this.conversation.rememberTopicRoute(...args)
  readonly resolveRoute = (...args: Parameters<ConversationRepository['resolveRoute']>): ReturnType<ConversationRepository['resolveRoute']> => this.conversation.resolveRoute(...args)
  readonly resolveThreadRouting = (...args: Parameters<ConversationRepository['resolveThreadRouting']>): ReturnType<ConversationRepository['resolveThreadRouting']> => this.conversation.resolveThreadRouting(...args)
  readonly listThreadRoutingRules = (...args: Parameters<ConversationRepository['listThreadRoutingRules']>): ReturnType<ConversationRepository['listThreadRoutingRules']> => this.conversation.listThreadRoutingRules(...args)
  readonly getThreadRoutingRule = (...args: Parameters<ConversationRepository['getThreadRoutingRule']>): ReturnType<ConversationRepository['getThreadRoutingRule']> => this.conversation.getThreadRoutingRule(...args)
  readonly setThreadRoutingRule = (...args: Parameters<ConversationRepository['setThreadRoutingRule']>): ReturnType<ConversationRepository['setThreadRoutingRule']> => this.conversation.setThreadRoutingRule(...args)
  readonly processThreadProfileJobs = (...args: Parameters<ConversationRepository['processThreadProfileJobs']>): ReturnType<ConversationRepository['processThreadProfileJobs']> => this.conversation.processThreadProfileJobs(...args)
  readonly listThreadProfiles = (...args: Parameters<ConversationRepository['listThreadProfiles']>): ReturnType<ConversationRepository['listThreadProfiles']> => this.conversation.listThreadProfiles(...args)
  readonly listThreadRoutingDecisions = (...args: Parameters<ConversationRepository['listThreadRoutingDecisions']>): ReturnType<ConversationRepository['listThreadRoutingDecisions']> => this.conversation.listThreadRoutingDecisions(...args)
  readonly messageMatchesScene = (...args: Parameters<ConversationRepository['messageMatchesScene']>): ReturnType<ConversationRepository['messageMatchesScene']> => this.conversation.messageMatchesScene(...args)
  readonly claimScenePicker = (...args: Parameters<ConversationRepository['claimScenePicker']>): ReturnType<ConversationRepository['claimScenePicker']> => this.conversation.claimScenePicker(...args)
  readonly upsertChatMetadata = (...args: Parameters<ConversationRepository['upsertChatMetadata']>): ReturnType<ConversationRepository['upsertChatMetadata']> => this.conversation.upsertChatMetadata(...args)
  readonly listChatMetadata = (...args: Parameters<ConversationRepository['listChatMetadata']>): ReturnType<ConversationRepository['listChatMetadata']> => this.conversation.listChatMetadata(...args)
  readonly listChatIdsForMetadataSync = (...args: Parameters<ConversationRepository['listChatIdsForMetadataSync']>): ReturnType<ConversationRepository['listChatIdsForMetadataSync']> => this.conversation.listChatIdsForMetadataSync(...args)
  readonly latestSenderIdForChat = (...args: Parameters<ConversationRepository['latestSenderIdForChat']>): ReturnType<ConversationRepository['latestSenderIdForChat']> => this.conversation.latestSenderIdForChat(...args)
  readonly listObservedSenderIds = (...args: Parameters<ConversationRepository['listObservedSenderIds']>): ReturnType<ConversationRepository['listObservedSenderIds']> => this.conversation.listObservedSenderIds(...args)
  readonly listConversationThreads = (...args: Parameters<ConversationRepository['listConversationThreads']>): ReturnType<ConversationRepository['listConversationThreads']> => this.conversation.listConversationThreads(...args)
  readonly getConversationThread = (...args: Parameters<ConversationRepository['getConversationThread']>): ReturnType<ConversationRepository['getConversationThread']> => this.conversation.getConversationThread(...args)

  readonly provisioning: ProvisioningRepository
  readonly createProvisioningJob = (...args: Parameters<ProvisioningRepository['createProvisioningJob']>): ReturnType<ProvisioningRepository['createProvisioningJob']> => this.provisioning.createProvisioningJob(...args)
  readonly getProvisioningJob = (...args: Parameters<ProvisioningRepository['getProvisioningJob']>): ReturnType<ProvisioningRepository['getProvisioningJob']> => this.provisioning.getProvisioningJob(...args)
  readonly getProvisioningRequest = (...args: Parameters<ProvisioningRepository['getProvisioningRequest']>): ReturnType<ProvisioningRepository['getProvisioningRequest']> => this.provisioning.getProvisioningRequest(...args)
  readonly listProvisioningJobs = (...args: Parameters<ProvisioningRepository['listProvisioningJobs']>): ReturnType<ProvisioningRepository['listProvisioningJobs']> => this.provisioning.listProvisioningJobs(...args)
  readonly updateProvisioningJob = (...args: Parameters<ProvisioningRepository['updateProvisioningJob']>): ReturnType<ProvisioningRepository['updateProvisioningJob']> => this.provisioning.updateProvisioningJob(...args)
  readonly failInterruptedProvisioningJobs = (...args: Parameters<ProvisioningRepository['failInterruptedProvisioningJobs']>): ReturnType<ProvisioningRepository['failInterruptedProvisioningJobs']> => this.provisioning.failInterruptedProvisioningJobs(...args)

}
