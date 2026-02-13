/** 用户配置（users.json） */
export interface UserConfig {
  id: string;
  label: string;
  username: string;
  password: string;
}

/** 项目/清单 */
export interface Project {
  id: string;
  name: string;
  color?: string;
  closed?: boolean;
  groupId?: string;
  permission?: string;
  kind?: string;
  viewMode?: string;
  sortOrder?: number;
  sortType?: string;
  isOwner?: boolean;
  userCount?: number;
  muted?: boolean;
  teamId?: string;
  modifiedTime?: string;
  etag?: string;
}

/** 子任务/检查项 */
export interface ChecklistItem {
  id: string;
  title: string;
  status: number;
  sortOrder: number;
  isAllDay?: boolean;
  startDate?: string;
  completedTime?: string;
  timeZone?: string;
}

/** 任务 */
export interface Task {
  id: string;
  projectId: string;
  title: string;
  content?: string;
  desc?: string;
  isAllDay?: boolean;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  reminders?: string[];
  repeatFlag?: string;
  priority: number;
  status: number;
  completedTime?: string;
  createdTime?: string;
  modifiedTime?: string;
  kind?: string;
  tags?: string[];
  items?: ChecklistItem[];
  sortOrder?: number;
  parentId?: string;
  childIds?: string[];
  deleted?: number;
  deletedTime?: string;
  progress?: number;
  creator?: number;
}

/** 标签 */
export interface Tag {
  name: string;
  label: string;
  sortOrder: number;
  sortType: string;
  color: string;
  etag: string;
}

/** batch/check/0 响应 */
export interface BatchCheckResponse {
  checkPoint: number;
  syncTaskBean: {
    update: Task[];
    delete: string[];
    add: Task[];
    empty: boolean;
  };
  projectProfiles: Project[];
  tags: Tag[];
  inboxId: string;
}

/** 垃圾桶任务分页响应 */
export interface TrashResponse {
  tasks: Task[];
  next: number;
}

/** 任务统计 */
export interface TaskSummary {
  total_tasks: number;
  completed_tasks: number;
  pending_tasks: number;
  completion_rate: number;
}

/** 用户资料 */
export interface UserProfile {
  username: string;
  email: string;
  name: string;
  displayName: string;
  picture: string;
  userCode: string;
  phone: string;
  locale: string;
  gender: number;
  verifiedEmail: boolean;
  filledPassword: boolean;
  siteDomain: string;
  accountDomain: string;
}
