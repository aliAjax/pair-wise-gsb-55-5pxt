export type DeviceKind = 'line' | 'transformer' | 'bus' | 'breaker' | 'relay'
export type DeviceStatus = 'running' | 'maintenance' | 'stopped'
export type IssueType = 'overreach' | 'time-inversion' | 'sensitivity' | 'reclose'
export type IssueLevel = 'high' | 'medium' | 'low'
export type ReviewStatus = 'draft' | 'reviewing' | 'approved' | 'locked' | 'returned'

export interface Device {
  id: string
  code: string
  name: string
  kind: DeviceKind
  station: string
  voltage: number
  parentId?: string
  status: DeviceStatus
  operationModes: string[]
}

export interface ProtectionSetting {
  id: string
  relayId: string
  protectedDeviceId: string
  stage: 'I' | 'II' | 'III'
  currentA: number
  timeS: number
  direction: 'forward' | 'reverse' | 'non-directional'
  sensitivity: number
  recloseEnabled: boolean
  recloseDelayS: number
  startCondition: string
  updatedAt: string
}

/** 参与方式覆盖的定值字段（标识类字段不允许按方式覆盖） */
export type SettingValueField =
  | 'currentA'
  | 'timeS'
  | 'direction'
  | 'sensitivity'
  | 'recloseEnabled'
  | 'recloseDelayS'
  | 'startCondition'

/** 方式覆盖：只保存某运行方式下与基础定值不同的字段，其余字段继承基础定值 */
export interface SettingOverride {
  id: string
  settingId: string
  operationMode: string
  changes: Partial<Pick<ProtectionSetting, SettingValueField>>
  updatedAt: string
}

/** 旧版数据：每种运行方式各存一整份定值 */
export interface LegacyProtectionSetting extends ProtectionSetting {
  operationMode: string
}

/** 旧数据拆分升级的断点状态，随 state 持久化，失败后可从断点重试 */
export interface MigrationState {
  status: 'pending' | 'running' | 'failed' | 'done'
  totalModes: number
  doneModes: string[]
  failedMode?: string
  error?: string
  updatedAt: string
}

export interface ValidationIssue {
  id: string
  type: IssueType
  level: IssueLevel
  deviceIds: string[]
  settingIds: string[]
  message: string
  suggestion: string
  pairLabel: string
  status: 'open' | 'replying' | 'closed'
  createdAt: string
}

export interface ScenarioStep {
  sequence: number
  relayId: string
  action: string
  delayMs: number
  status: 'executed' | 'pending' | 'skipped'
}

export interface FaultScenario {
  id: string
  name: string
  operationMode: string
  faultDeviceId: string
  faultType: string
  status: ReviewStatus
  steps: ScenarioStep[]
  outageDevices: string[]
  createdAt: string
  notes: string
  /** 定值变更导致需重新确认的原因；重新批准后清除 */
  reconfirmReason?: string
}

export interface BaselineVersion {
  id: string
  version: string
  status: ReviewStatus
  createdAt: string
  lockedAt?: string
  createdBy: string
  note: string
  /** 创建基线时的运行方式；旧版基线无此字段，表示整份快照 */
  operationMode?: string
  snapshot: ProtectionSetting[]
  checksum: string
}

export interface ReviewComment {
  id: string
  targetType: 'issue' | 'baseline' | 'scenario'
  targetId: string
  author: string
  content: string
  createdAt: string
  status: 'open' | 'resolved'
}

export interface AuditEntry {
  id: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
}

export interface AppState {
  devices: Device[]
  settings: ProtectionSetting[]
  overrides: SettingOverride[]
  activeMode: string
  migration?: MigrationState
  issues: ValidationIssue[]
  scenarios: FaultScenario[]
  baselines: BaselineVersion[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  activeBaselineId?: string
}

export interface SettingDiff {
  settingId: string
  relayName: string
  field: keyof ProtectionSetting
  before: string | number | boolean
  after: string | number | boolean
}
