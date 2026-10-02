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

/** 运行方式可覆盖的定值字段 */
export type SettingFieldKey =
  | 'currentA'
  | 'timeS'
  | 'direction'
  | 'sensitivity'
  | 'recloseEnabled'
  | 'recloseDelayS'
  | 'startCondition'

/** 方式覆盖：只装本方式与基础定值不同的字段，其余字段继承基础定值 */
export interface ModeOverride {
  id: string
  mode: string
  settingId: string
  changes: Partial<Pick<ProtectionSetting, SettingFieldKey>>
  updatedAt: string
}

/** 旧数据迁移断点：记录已拆分的方式，失败后可从断点重试 */
export interface MigrationState {
  status: 'running' | 'failed' | 'done'
  processedModes: string[]
  totalModes: string[]
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
  /** 基础定值或本方式覆盖变更后需要重新确认，动作序列与停电范围保留 */
  reconfirmRequired?: boolean
}

export interface BaselineVersion {
  id: string
  version: string
  status: ReviewStatus
  createdAt: string
  lockedAt?: string
  createdBy: string
  note: string
  /** 录制快照时的运行方式；历史基线可能没有该字段，仍按原快照查看 */
  mode?: string
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
  /** 基础定值，各方式未覆盖的字段都从这里继承 */
  settings: ProtectionSetting[]
  /** 方式覆盖：仅记录本方式与基础定值不同的字段 */
  overrides: ModeOverride[]
  /** 当前运行方式，校核、基线比较和导出都以它为准 */
  activeMode: string
  schemaVersion: number
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
