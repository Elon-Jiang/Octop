/**
 * 云服务器模块统一色彩语义：
 *   充足 / 低水位  → 绿
 *   正常 / 中等水位 → 蓝
 *   告警 / 紧张    → 红
 *   无采样 / 离线  → 灰
 *
 * 阈值：< 50% 视为充足，50–79% 视为正常，≥ 80% 视为告警。
 */

export type ToneKey = "good" | "normal" | "alert" | "offline";

export type Tone = {
  key: ToneKey;
  /** 主色：圆环进度、进度条、热力格 */
  stroke: string;
  /** 轨道底色 */
  track: string;
  /** 文字色 */
  ink: string;
  /** 徽章底色 */
  bg: string;
  /** 中文标签 */
  label: string;
};

export const TONE: Record<ToneKey, Tone> = {
  good: {
    key: "good",
    stroke: "#2fae87",
    track: "#e4f4ee",
    ink: "#138c6b",
    bg: "#eaf8f1",
    label: "充足",
  },
  normal: {
    key: "normal",
    stroke: "#4a86d8",
    track: "#e6eefb",
    ink: "#2f6fb5",
    bg: "#e9f1fb",
    label: "正常",
  },
  alert: {
    key: "alert",
    stroke: "#df5665",
    track: "#fbe7e9",
    ink: "#c64756",
    bg: "#fdefef",
    label: "告警",
  },
  offline: {
    key: "offline",
    stroke: "#c7ced9",
    track: "#eef1f5",
    ink: "#8b939f",
    bg: "#f0f2f5",
    label: "无采样",
  },
};

export const GOOD_MAX = 50;
export const ALERT_MIN = 80;

/** 按资源水位取名次色。 */
export function levelTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return TONE.offline;
  }
  if (value >= ALERT_MIN) return TONE.alert;
  if (value >= GOOD_MAX) return TONE.normal;
  return TONE.good;
}

/**
 * 按健康态取色：在线/健康=绿，关注/异常=红（告警），离线=灰。
 * 注意这与 levelTone 是两套语义：
 *   healthTone 描述"节点活着吗"，绿色代表在线；
 *   levelTone  描述"资源用多少"，蓝色代表中等水位。
 */
export function healthTone(health: string): Tone {
  if (health === "offline") return TONE.offline;
  if (health === "warning" || health === "critical" || health === "alert") {
    return TONE.alert;
  }
  return TONE.good;
}

/** 热力条五档：绿 → 蓝 → 红。 */
export const HEAT_COLORS = ["#e6f5ef", "#9ed7bf", "#a9c8ec", "#4a86d8", "#df5665"];

/** 趋势曲线配色：主色偏蓝，网络保留青/绿以区分上下行。 */
export const SERIES_COLOR = {
  cpu: "#4a86d8",
  mem: "#8b7fd4",
  load: "#5f7d99",
  net_in: "#4a9fc4",
  net_out: "#3fa98a",
} as const;
