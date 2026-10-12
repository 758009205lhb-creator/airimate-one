/**
 * @airimate/radial-menu/icons —— 独立图标集（**不复制 Mate 的美术资产**）
 *
 * 全部为手写的 24×24 线性几何，风格统一（1.6 描边、圆头圆角）。
 * 设计取向：毛玻璃 + 细线几何，刻意与 Mate 的 Unity 素面圆盘区分。
 */

export type IconName =
  | 'chat' | 'hearing' | 'speaker' | 'avatar'
  | 'settings' | 'center' | 'pin' | 'sleep'

export const ICONS: Record<IconName, string> = {
  // 对话：圆角气泡 + 三点省略
  chat: '<path d="M4.2 6.4a2.2 2.2 0 0 1 2.2-2.2h11.2a2.2 2.2 0 0 1 2.2 2.2v7.2a2.2 2.2 0 0 1-2.2 2.2H9.6l-4 3.4a.6.6 0 0 1-1-.46V6.4Z"/><circle cx="9" cy="10" r="1"/><circle cx="12" cy="10" r="1"/><circle cx="15" cy="10" r="1"/>',
  // 听力：麦克风 + 声波弧
  hearing: '<rect x="9" y="3.4" width="6" height="10.4" rx="3"/><path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0"/><path d="M12 18v2.6"/><path d="M18.6 6.2a7.6 7.6 0 0 1 0 8.4"/>',
  // 扬声器：喇叭 + 两道声波
  speaker: '<path d="M4.4 9.6h3.2l4.2-3.6a.6.6 0 0 1 1 .46v11.1a.6.6 0 0 1-1 .46L7.6 14.4H4.4Z"/><path d="M16 8.6a4.6 4.6 0 0 1 0 6.8"/><path d="M18.6 6.2a8 8 0 0 1 0 11.6"/>',
  // 角色：头肩剪影 + 光晕
  avatar: '<circle cx="12" cy="8.6" r="3.6"/><path d="M4.8 20.2a7.4 7.4 0 0 1 14.4 0"/><circle cx="12" cy="12" r="9.2" stroke-dasharray="2.4 3.2"/>',
  // 设置：齿轮（八齿，几何构造）
  settings: '<circle cx="12" cy="12" r="3.1"/><path d="M12 3.2v2.3M12 18.5v2.3M4.8 7.6l2 1.15M17.2 15.25l2 1.15M4.8 16.4l2-1.15M17.2 8.75l2-1.15"/><circle cx="12" cy="12" r="8.2" stroke-dasharray="1.6 2.6"/>',
  // 居中：十字准星 + 中心点
  center: '<path d="M12 3.6v3.2M12 17.2v3.2M3.6 12h3.2M17.2 12h3.2"/><circle cx="12" cy="12" r="3.4"/><circle cx="12" cy="12" r="8.4" stroke-dasharray="2 3"/>',
  // 置顶：图钉（斜置）
  pin: '<path d="M14.6 3.8 20.2 9.4l-3 1.2-3.9 3.9.6 3.5-1.6 1.6-3-3-3.9 3.9-1.1-1.1 3.9-3.9-3-3L6.8 6.9l3.5.6 3.9-3.9Z"/>',
  // 休眠：月牙 + 星点
  sleep: '<path d="M20 14.6A8.4 8.4 0 0 1 9.4 4a8.6 8.6 0 1 0 10.6 10.6Z"/><path d="M16.4 4.2l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5Z"/>',
}

/** 图标 id → 语义名（用于可访问性标签） */
export const ICON_LABELS: Record<string, string> = {
  chat: '对话面板',
  hearing: '听你说话',
  speaker: '语音朗读',
  avatar: '角色与外观',
  settings: '设置',
  center: '移到屏幕中央',
  pin: '窗口置顶',
  sleep: '休眠',
}
