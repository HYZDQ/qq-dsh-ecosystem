// @dsh/computer-runtime 公开导出面（§3.3 阶段 B/C）：
// 桌面 UIA/坐标 + 网页 DOM + 视觉兜底 + 任务自治（触发/状态机/预算）+ 安全闸门（策略/确认/收据/熔断/急停）。
export { ComputerRuntime, computerStateDir, ensureComputerDir } from './computer/runtime.mjs';
export {
  defaultPolicy, loadPolicy, updatePolicy, policyPath, stopFilePath, stopRequested, fail,
  assertAdminControl, checkWriteAllowed, checkBrowserWriteAllowed, checkBrowserDomainAllowed,
  ALLOWED_DRIVER_TOOLS, FORBIDDEN_DRIVER_TOOLS, CircuitBreaker,
} from './computer/policy.mjs';
export {
  COMPUTER_TOOL_DEFINITIONS, COMPUTER_WRITE_TOOLS, COMPUTER_TASK_TOOLS,
  COMPUTER_L2_TOOL_DEFINITIONS, COMPUTER_L2_TOOLS,
} from './computer/tool-definitions.mjs';
export { PackRegistry, BUILTIN_PACKS, PACKS_FILENAME } from './computer/packs/registry.mjs';
export { DomainPack, PACK_ALLOWED_TOOLS } from './computer/packs/domain-pack.mjs';
export { TaskStore } from './computer/tasks/checkpoint.mjs';
export { TaskStateMachine, normalizeBudget, DEFAULT_BUDGET, stepKeyOf } from './computer/tasks/state-machine.mjs';
export { ScheduleStore, SCHEDULES_FILENAME } from './computer/tasks/schedules.mjs';
export { LocalScheduler } from './computer/tasks/scheduler.mjs';
export { BrowserDriver } from './computer/browser-driver.mjs';
export { VisionFallback, captureFrame, captureViaPowerShell } from './computer/vision.mjs';
export { createVisionLocate, parseLocateReply } from './computer/vision-adapter.mjs';
export { EventBridge, EVENTS_DIRNAME } from './computer/tasks/event-bridge.mjs';
export { sessionLocked, parseTasklistImages } from './computer/session.mjs';
export { probeProcessTitles, mergeWindows, parseTasklistCsv } from './computer/window-discovery.mjs';
export { registerComputerChecks } from './computer/diagnostics.mjs';
export { AuditLog } from './computer/audit.mjs';
export { ConfirmStore } from './computer/confirm.mjs';
