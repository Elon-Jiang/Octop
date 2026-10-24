import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Activity,
  ArrowLeft,
  Check,
  Clock,
  Copy,
  Cpu,
  HardDrive,
  Info,
  MemoryStick,
  Network,
  Server,
  Shield,
  Sparkles,
} from "lucide-react";

import {
  HEAT_COLORS,
  SERIES_COLOR,
  TONE,
  healthTone,
  levelTone,
} from "../theme";
import styles from "./NodeDetailView.module.less";

export type DetailRange = "1h" | "24h" | "7d";

export type DetailInstance = {
  name: string;
  instance_id: string;
  region: string;
  zone: string;
  os_name: string;
  cpu: number;
  memory_gb: number;
  private_ips: string[];
  public_ips: string[];
  state: string;
};

type Point = { t: number; v: number };
type SeriesMap = Record<string, Point[] | undefined>;
type Row = { t: number } & Partial<Record<Key, number>>;

const RANGE_LABEL: Record<DetailRange, string> = {
  "1h": "最近 1 小时",
  "24h": "最近 24 小时",
  "7d": "最近 7 天",
};

const RANGE_STEP: Record<DetailRange, number> = { "1h": 60, "24h": 300, "7d": 3600 };

const RANGE_SECONDS: Record<DetailRange, number> = {
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
};

/** 理论采样点数（含首尾端点），与原型 ranges.count 一致。 */
const RANGE_EXPECTED: Record<DetailRange, number> = {
  "1h": 61,
  "24h": 289,
  "7d": 169,
};

const MIN_ZOOM_POINTS = 3;

const CITY_NAME: Record<string, string> = {
  "ap-guangzhou": "广州",
  "ap-shanghai": "上海",
  "ap-beijing": "北京",
  "ap-chengdu": "成都",
  "ap-nanjing": "南京",
  "ap-chongqing": "重庆",
  "ap-shenzhen": "深圳",
  "ap-hongkong": "香港",
  "ap-taipei": "台北",
  "ap-singapore": "新加坡",
  "ap-tokyo": "东京",
  "ap-seoul": "首尔",
  "ap-mumbai": "孟买",
  "ap-bangkok": "曼谷",
  "ap-jakarta": "雅加达",
  "ap-siliconvalley": "硅谷",
  "ap-frankfurt": "法兰克福",
  "ap-moscow": "莫斯科",
  "ap-toronto": "多伦多",
  "na-ashburn": "弗吉尼亚",
  "na-siliconvalley": "硅谷",
  "eu-frankfurt": "法兰克福",
};

const META = {
  cpu: { label: "CPU", color: SERIES_COLOR.cpu, unit: "%" },
  mem: { label: "内存", color: SERIES_COLOR.mem, unit: "%" },
  load: { label: "系统负载", color: SERIES_COLOR.load, unit: "" },
  disk_usage: { label: "磁盘", color: SERIES_COLOR.cpu, unit: "%" },
  net_in: { label: "下行", color: SERIES_COLOR.net_in, unit: "Mbps" },
  net_out: { label: "上行", color: SERIES_COLOR.net_out, unit: "Mbps" },
} as const;

type Key = keyof typeof META;

const GROUPS: Record<string, Key[]> = {
  overview: ["cpu", "mem"],
  load: ["load"],
  network: ["net_in", "net_out"],
};

const GROUP_UNIT: Record<string, string> = {
  overview: "资源使用率 / %",
  load: "系统负载 / 无量纲",
  network: "网络吞吐 / Mbps",
};

const clock = (t: number, withSeconds = false) =>
  new Date(t * 1000).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });

const dateTime = (t: number) => {
  const date = new Date(t * 1000);
  return `${date.getMonth() + 1}/${date.getDate()} ${clock(t)}`;
};

const fmt = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);

const pct = (value: number | null) => (value === null ? "—" : `${value.toFixed(1)}%`);

function statsOf(points: Point[] | undefined) {
  const values = (points ?? []).map((point) => point.v).filter(Number.isFinite);
  if (!values.length) {
    return { latest: null, avg: null, peak: null, min: null, count: 0 };
  }
  return {
    latest: values[values.length - 1],
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    peak: Math.max(...values),
    min: Math.min(...values),
    count: values.length,
  };
}

function heatLevel(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < 20) return 0;
  if (value < 40) return 1;
  if (value < 60) return 2;
  if (value < 80) return 3;
  return 4;
}

const ringStroke = 7;
const ringRadius = 33;
const ringCircumference = 2 * Math.PI * ringRadius;

export default function NodeDetailView({
  instance,
  series,
  loading,
  range,
  onRangeChange,
  onBack,
  focusTs,
  onFocusTs,
}: {
  instance: DetailInstance;
  series: SeriesMap;
  loading: boolean;
  range: DetailRange;
  onRangeChange: (value: DetailRange) => void;
  onBack: () => void;
  focusTs: number | null;
  onFocusTs: (value: number | null) => void;
}) {
  const [group, setGroup] = useState<keyof typeof GROUPS>("overview");
  const [hidden, setHidden] = useState<Key[]>([]);
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [width, setWidth] = useState(800);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 800;
      setWidth(Math.max(300, Math.round(next)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo<Row[]>(() => {
    const map = new Map<number, Row>();
    (Object.keys(META) as Key[]).forEach((key) => {
      for (const point of series[key] ?? []) {
        if (!Number.isFinite(point.v)) continue;
        const row = map.get(point.t) ?? { t: point.t };
        row[key] = point.v;
        map.set(point.t, row);
      }
    });
    return [...map.values()].sort((a, b) => a.t - b.t);
  }, [series]);

  const stats = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(META) as Key[]).map((key) => [key, statsOf(series[key])]),
      ) as Record<Key, ReturnType<typeof statsOf>>,
    [series],
  );

  const cores = instance.cpu || 1;
  const perCore = stats.load.latest === null ? null : stats.load.latest / cores;
  const cityOf = CITY_NAME[instance.region] ?? instance.region;
  const zoneNo = instance.zone ? (instance.zone.split("-").pop() ?? "") : "";
  const privateIp = instance.private_ips[0] || "";

  const copyIp = async () => {
    if (!privateIp) return;
    try {
      await navigator.clipboard.writeText(privateIp);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  const status = useMemo(() => {
    if (instance.state === "STOPPED") return "offline" as const;
    if (stats.cpu.latest === null && stats.mem.latest === null) return "offline" as const;
    const peak = Math.max(stats.cpu.latest ?? 0, stats.mem.latest ?? 0, stats.disk_usage.latest ?? 0);
    if (peak >= 90) return "critical" as const;
    if (peak >= 80) return "warning" as const;
    return "healthy" as const;
  }, [instance.state, stats]);

  const statusText =
    status === "offline" ? "离线" : status === "critical" ? "异常" : status === "warning" ? "关注" : "健康";
  const statusTone = healthTone(status);

  const loadTone =
    perCore === null
      ? TONE.offline
      : perCore >= 1
        ? TONE.alert
        : perCore >= 0.7
          ? TONE.normal
          : TONE.good;

  const sampleEnd = rows.length ? rows[rows.length - 1].t : null;

  const windowRows = zoom ? rows.slice(zoom.start, zoom.end + 1) : rows;
  const activeKeys = GROUPS[group].filter((key) => !hidden.includes(key));

  const expected = RANGE_EXPECTED[range];

  // 与原型 buildHeatmap 一致：按理论采样点数切桶（1h=61 格，24h/7d=72 格）
  const buckets = useMemo(() => {
    const cpu = series.cpu ?? [];
    if (!cpu.length) return [];
    const end = cpu[cpu.length - 1].t;
    const span = RANGE_SECONDS[range];
    const step = span / (expected - 1);
    const first = end - span;
    const cells = Math.min(72, expected);

    return Array.from({ length: cells }, (_, index) => {
      const startIndex = Math.floor((index * expected) / cells);
      const endIndex = Math.floor(((index + 1) * expected) / cells) - 1;
      const from = first + startIndex * step;
      const to = first + endIndex * step;
      const slice = cpu.filter((point) => point.t >= from && point.t <= to);
      const avg = slice.length
        ? slice.reduce((sum, point) => sum + point.v, 0) / slice.length
        : null;
      return {
        index,
        startT: Math.round(from),
        endT: Math.round(to),
        coverageStartT: Math.round(
          first + (startIndex === 0 ? 0 : (startIndex - 0.5) * step),
        ),
        coverageEndT: Math.round(
          first +
            (endIndex === expected - 1 ? span : (endIndex + 0.5) * step),
        ),
        avg,
        count: slice.length,
        level: heatLevel(avg),
      };
    });
  }, [series.cpu, range, expected]);

  const geometry = useMemo(() => {
    const height = 260;
    const left = 43;
    const right = width - 15;
    const top = 18;
    const bottom = height - 35;
    let ceiling = 100;
    if (group !== "overview") {
      const values = windowRows.flatMap((row) =>
        activeKeys.map((key) => row[key] ?? 0),
      );
      const max = Math.max(group === "load" ? cores : 1, ...values) * 1.15;
      const scale = 10 ** Math.floor(Math.log10(max || 1));
      ceiling = (Math.ceil((max / scale) * 2) / 2) * scale;
    }
    return { width, height, left, right, top, bottom, ceiling };
  }, [width, group, windowRows, activeKeys, cores]);

  const tickTime = (t: number) => (range === "1h" ? clock(t) : dateTime(t));
  const xTickCount = width < 420 ? 3 : 5;

  const axisFrom = windowRows.length
    ? windowRows[0].t
    : (sampleEnd ?? 0) - RANGE_SECONDS[range];
  const axisTo = windowRows.length
    ? windowRows[windowRows.length - 1].t
    : (sampleEnd ?? 0);

  const refLine =
    group === "overview" || group === "load"
      ? {
          value: group === "overview" ? 80 : cores,
          label: group === "overview" ? "80% 参考线" : `${cores} 核参考线`,
          width: group === "overview" ? 76 : 87,
        }
      : null;

  const toggleSeries = (key: Key) => {
    if (!GROUPS[group].includes(key)) return;
    const shown = GROUPS[group].filter((item) => !hidden.includes(item));
    if (shown.length <= 1 && !hidden.includes(key)) return;
    setHidden((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );
  };

  const focusBucket = (startT: number, endT: number) => {
    if (rows.length < MIN_ZOOM_POINTS) return;
    let start = rows.findIndex((row) => row.t >= startT);
    if (start < 0) start = rows.length - 1;
    let end = rows.findIndex((row) => row.t >= endT);
    if (end < 0) end = start;
    const padding = start === end ? 2 : 1;
    const from = Math.max(0, Math.min(start, end) - padding);
    const to = Math.min(rows.length - 1, Math.max(start, end) + padding);
    if (to - from < 2) return;
    setZoom({ start: from, end: to });
    setGroup("overview");
    setHidden((prev) => prev.filter((key) => key !== "cpu"));
    onFocusTs(startT);
  };

  const pointed = hover !== null ? windowRows[hover] : null;

  const hoverX =
    hover === null
      ? null
      : geometry.left +
        (geometry.right - geometry.left) *
          (windowRows.length <= 1 ? 1 : hover / (windowRows.length - 1));

  const tooltipLeft = useMemo(() => {
    if (hoverX === null) return 0;
    return Math.min(Math.max(hoverX + 12, 5), Math.max(5, width - 190));
  }, [hoverX, width]);

  const sparkPoints = (key: Key, ceiling: number) => {
    const points = series[key] ?? [];
    if (!points.length) return "";
    return points
      .map((point, index) => {
        const x = (index / Math.max(points.length - 1, 1)) * 220;
        const y = 28 - (point.v / ceiling) * 25;
        return `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");
  };

  const networkCeiling =
    Math.max(
      1,
      ...(series.net_in ?? []).map((point) => point.v),
      ...(series.net_out ?? []).map((point) => point.v),
    ) * 1.1;

  const ringState = (key: Key) => {
    const value = stats[key].latest;
    const numeric = value ?? 0;
    const valid = value !== null && Number.isFinite(value);
    const tone = levelTone(valid ? numeric : null);
    return { value, numeric, valid, tone };
  };

  const ringBlock = (key: Key, caption: string) => {
    const { value, numeric, valid, tone } = ringState(key);
    const ratio = valid ? Math.max(0, Math.min(100, numeric)) / 100 : 0;
    const occupied = ringCircumference * ratio;
    const rounded = valid && occupied > ringStroke && ratio < 1;
    const dash = rounded ? occupied - ringStroke : occupied;
    const capAngle = rounded ? (ringStroke / 2 / ringCircumference) * 360 : 0;

    return (
      <>
        <div
          className={`${styles.resourceRing} ${valid ? "" : styles.ringMissing}`}
          style={
            {
              "--ring-color": tone.stroke,
              "--ring-track": tone.track,
            } as CSSProperties
          }
        >
          <svg viewBox="0 0 80 80" aria-hidden="true">
            <circle
              className={styles.ringTrack}
              cx="40"
              cy="40"
              r={ringRadius}
              fill="none"
              strokeWidth={ringStroke}
            />
            <circle
              className={styles.ringProgress}
              cx="40"
              cy="40"
              r={ringRadius}
              fill="none"
              strokeWidth={ringStroke}
              strokeLinecap={rounded ? "round" : "butt"}
              strokeDasharray={`${dash.toFixed(3)} ${(ringCircumference - dash).toFixed(3)}`}
              transform={`rotate(${(-90 + capAngle).toFixed(3)} 40 40)`}
              style={{ opacity: valid && ratio > 0 ? 1 : 0 }}
            />
          </svg>
          <div className={styles.ringCenter}>
            <span className={styles.kpiNumber}>{fmt(value)}</span>
            <span className={styles.kpiUnit}>%</span>
          </div>
        </div>
        <div className={styles.resourceSide}>
          <span className={styles.ringState} data-tone={tone.key}>
            {tone.label}
          </span>
          <p className={styles.kpiCaption}>{caption}</p>
        </div>
      </>
    );
  };

  const observations = useMemo(() => {
    if (status === "offline") {
      return [
        ["当前状态", "节点离线或暂无采样，未生成有效序列。", "#a0aabb"],
        ["缺测处理", "CPU / 内存 / 负载不计为 0，也不参与均值。", "#a0aabb"],
        ["配置可见", `${cores} vCPU · ${instance.memory_gb} GiB 内存为实例配置。`, "#a0aabb"],
      ] as const;
    }
    return [
      [
        "区间 CPU 峰值",
        `${pct(stats.cpu.peak)} · ${(stats.cpu.peak ?? 0) >= 80 ? "历史触及 80% 参考线" : "历史未触及 80% 参考线"}`,
        (stats.cpu.peak ?? 0) >= 80 ? TONE.alert.stroke : TONE.good.stroke,
      ],
      [
        "内存波动",
        `${fmt((stats.mem.peak ?? 0) - (stats.mem.min ?? 0))} 个百分点 · 均值 ${pct(stats.mem.avg)}`,
        TONE.normal.stroke,
      ],
      [
        "当前健康判断",
        `${statusText} · 当前资源最高 ${pct(
          Math.max(stats.cpu.latest ?? 0, stats.mem.latest ?? 0, stats.disk_usage.latest ?? 0),
        )}`,
        levelTone(
          Math.max(stats.cpu.latest ?? 0, stats.mem.latest ?? 0, stats.disk_usage.latest ?? 0),
        ).stroke,
      ],
    ] as const;
  }, [status, statusText, stats, cores, instance.memory_gb]);

  const detailRows: Array<[string, string]> = [
    ["地域", instance.region],
    ["可用区", zoneNo ? `${cityOf} ${zoneNo}` : "—"],
    ["私网 IP", privateIp || "—"],
    ["公网 IP", instance.public_ips[0] || "未配置"],
    ["系统", instance.os_name || "—"],
    ["规格", `${cores}c / ${instance.memory_gb} GiB`],
  ];

  const diskUsage = stats.disk_usage.latest;

  return (
    <div className={styles.page}>
      <section className={styles.identity}>
        <div className={styles.identityTop}>
          <div className={styles.breadcrumb}>
            <span>云服务器</span>
            <span className={styles.slash}>/</span>
            <span>节点监控</span>
          </div>
          <button type="button" className={styles.backLink} onClick={onBack}>
            <ArrowLeft size={13} />
            返回节点总览
          </button>
        </div>

        <div className={styles.identityRow}>
          <div>
            <div className={styles.identityName}>
              <span className={styles.titleIcon}>
                <Server size={20} />
              </span>
              <h1 className={styles.title}>{instance.name}</h1>
              <span className={styles.badge} data-tone={statusTone.key}>
                <i className={styles.dot} />
                {statusText}
              </span>
            </div>
            <div className={styles.identityMeta}>
              <button
                type="button"
                className={`${styles.ipCopy} ${styles.mono}`}
                onClick={() => void copyIp()}
                title={`复制私网 IP ${privateIp || "—"}`}
              >
                <span>{privateIp || "—"}</span>
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
              <span className={styles.sep}>·</span>
              <span>
                {cityOf}
                {zoneNo ? ` · 可用区 ${zoneNo}` : ""}
              </span>
              {instance.os_name ? (
                <>
                  <span className={styles.sep}>·</span>
                  <span>{instance.os_name}</span>
                </>
              ) : null}
              <span className={styles.specChip}>{cores} vCPU</span>
              <span className={styles.specChip}>{instance.memory_gb} GiB</span>
            </div>
          </div>

          <div className={styles.identityTools}>
            <span
              className={styles.sampleIndicator}
              data-paused={status === "offline" ? "true" : "false"}
            >
              <i className={styles.dot} />
              {status === "offline" ? "离线 · 无采样" : loading ? "采集中" : "实时采样"}
            </span>
            <div className={styles.segmented}>
              {(["1h", "24h", "7d"] as DetailRange[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={key === range ? styles.segActive : ""}
                  onClick={() => {
                    setZoom(null);
                    onFocusTs(null);
                    onRangeChange(key);
                  }}
                >
                  {key === "1h" ? "近 1h" : key === "24h" ? "近 24h" : "近 7d"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className={styles.summaryBand} data-tone={statusTone.key}>
        <Shield size={15} />
        <strong>
          {status === "offline"
            ? "节点离线"
            : status === "critical"
              ? "有指标处于高位"
              : status === "warning"
                ? "有指标需关注"
                : "运行稳定"}
        </strong>
        <span className={styles.summaryDivider}>/</span>
        <span>
          {status === "offline"
            ? "缺测不计为 0 · 配置仍可查看"
            : status === "critical"
              ? "当前资源 ≥90% · 查看监控观察"
              : status === "warning"
                ? "当前资源 ≥80% · 建议持续观察"
                : "当前资源处于正常区间"}
        </span>
        <span className={styles.summaryDivider}>·</span>
        <span>每 {RANGE_STEP[range]} 秒采样</span>
        <span className={styles.summaryTime}>
          采样{" "}
          <span className={styles.mono}>
            {sampleEnd ? clock(sampleEnd, true) : "—"}
          </span>
        </span>
      </div>

      <section className={styles.kpiGrid}>
        <article className={`${styles.kpi} ${styles.resourceCard} ${styles.cpuCard}`}>
          <div className={styles.kpiHead}>
            <span>CPU 使用率</span>
            <Cpu size={15} />
          </div>
          <div className={styles.resourceBody}>
            {ringBlock(
              "cpu",
              status === "offline"
                ? `配置 ${cores} vCPU · 无采样`
                : `${cores} vCPU · 当前占用`,
            )}
          </div>
          <div className={styles.kpiStatRow}>
            <span>
              区间均值 <strong className={styles.mono}>{pct(stats.cpu.avg)}</strong>
            </span>
            <span>
              峰值 <strong className={styles.mono}>{pct(stats.cpu.peak)}</strong>
            </span>
          </div>
          <div className={styles.kpiUpdate}>
            <i className={styles.dot} />
            {sampleEnd ? clock(sampleEnd, true) : "—"} · 实时末点
          </div>
        </article>

        <article className={`${styles.kpi} ${styles.resourceCard} ${styles.memoryCard}`}>
          <div className={styles.kpiHead}>
            <span>内存使用率</span>
            <MemoryStick size={15} />
          </div>
          <div className={styles.resourceBody}>
            {ringBlock(
              "mem",
              stats.mem.latest === null
                ? `— / ${instance.memory_gb} GiB 配置`
                : `${fmt((instance.memory_gb * stats.mem.latest) / 100)} / ${instance.memory_gb} GiB`,
            )}
          </div>
          <div className={styles.kpiStatRow}>
            <span>
              区间均值 <strong className={styles.mono}>{pct(stats.mem.avg)}</strong>
            </span>
            <span>
              峰值 <strong className={styles.mono}>{pct(stats.mem.peak)}</strong>
            </span>
          </div>
          <div className={styles.kpiUpdate}>
            <i className={styles.dot} />
            {sampleEnd ? clock(sampleEnd, true) : "—"} · 实时末点
          </div>
        </article>

        <article className={`${styles.kpi} ${styles.resourceCard} ${styles.diskCard}`}>
          <div className={styles.kpiHead}>
            <span>磁盘使用率</span>
            <HardDrive size={15} />
          </div>
          <div className={styles.resourceBody}>
            {ringBlock(
              "disk_usage",
              diskUsage === null ? "暂无磁盘采样" : `已用 ${pct(diskUsage)}`,
            )}
          </div>
          <div className={styles.kpiStatRow}>
            <span>
              区间均值 <strong className={styles.mono}>{pct(stats.disk_usage.avg)}</strong>
            </span>
            <span>
              峰值 <strong className={styles.mono}>{pct(stats.disk_usage.peak)}</strong>
            </span>
          </div>
          <div className={styles.kpiUpdate}>
            <i className={styles.dot} />
            {sampleEnd ? clock(sampleEnd, true) : "—"} · 实时末点
          </div>
        </article>

        <article className={`${styles.kpi} ${styles.networkCard}`}>
          <div className={styles.kpiHead}>
            <span>网络吞吐</span>
            <Network size={15} />
          </div>
          <div className={styles.networkMain}>
            <div>
              <span className={styles.networkNumber}>{fmt(stats.net_in.latest)}</span>
              <div className={styles.networkDirection}>
                ↓ 下行 <span className={styles.kpiUnit}>Mbps</span>
              </div>
            </div>
            <div>
              <span className={styles.networkNumber}>{fmt(stats.net_out.latest)}</span>
              <div className={styles.networkDirection}>
                ↑ 上行 <span className={styles.kpiUnit}>Mbps</span>
              </div>
            </div>
          </div>
          <svg
            className={styles.kpiSpark}
            viewBox="0 0 220 30"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {series.net_in && series.net_in.length > 1 ? (
              <path
                d={`${sparkPoints("net_in", networkCeiling)} L220 30 L0 30Z`}
                fill={META.net_in.color}
                opacity="0.055"
              />
            ) : null}
            {series.net_in?.length ? (
              <path
                d={sparkPoints("net_in", networkCeiling)}
                fill="none"
                stroke={META.net_in.color}
                strokeWidth="1.65"
              />
            ) : null}
            {series.net_out && series.net_out.length > 1 ? (
              <path
                d={`${sparkPoints("net_out", networkCeiling)} L220 30 L0 30Z`}
                fill={META.net_out.color}
                opacity="0.055"
              />
            ) : null}
            {series.net_out?.length ? (
              <path
                d={sparkPoints("net_out", networkCeiling)}
                fill="none"
                stroke={META.net_out.color}
                strokeWidth="1.65"
              />
            ) : null}
          </svg>
          <div className={styles.kpiStatRow}>
            <span>
              下行峰值 <strong className={styles.mono}>{fmt(stats.net_in.peak)}</strong>
            </span>
            <span>
              上行峰值 <strong className={styles.mono}>{fmt(stats.net_out.peak)}</strong>
            </span>
          </div>
          <div className={styles.kpiUpdate}>
            <i className={styles.dot} />
            {sampleEnd ? clock(sampleEnd, true) : "—"} · 实时末点
          </div>
        </article>
      </section>

      <div className={styles.analysisGrid}>
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h2 className={styles.panelTitle}>
                性能趋势
                <span className={styles.badgeNeutral}>{rows.length} 点</span>
              </h2>
              <p className={styles.panelSubtitle}>
                {RANGE_LABEL[range]} · 每 {RANGE_STEP[range]} 秒采样
              </p>
            </div>
            <div className={styles.trendTools}>
              {zoom ? (
                <button
                  type="button"
                  className={styles.focusChip}
                  onClick={() => {
                    setZoom(null);
                    onFocusTs(null);
                  }}
                >
                  返回完整范围
                </button>
              ) : null}
              <div className={styles.segmented}>
                {(
                  [
                    ["overview", "概览"],
                    ["load", "负载"],
                    ["network", "网络"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={group === key ? styles.segActive : ""}
                    onClick={() => {
                      setGroup(key);
                      setZoom(null);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className={styles.legendRow}>
            {GROUPS[group].map((key) => {
              const isHidden = hidden.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  className={`${styles.legendBtn} ${isHidden ? styles.legendHidden : ""}`}
                  onClick={() => toggleSeries(key)}
                  style={{ "--series-color": META[key].color } as CSSProperties}
                >
                  <i className={styles.lineMark} />
                  {META[key].label}
                  <strong>
                    {META[key].unit
                      ? `${fmt(stats[key].latest, key === "load" ? 2 : 1)} ${META[key].unit}`
                      : fmt(stats[key].latest, 2)}
                  </strong>
                </button>
              );
            })}
            <span className={styles.legendNote}>点击图例显隐 · 末点 = 当前值</span>
          </div>

          <div className={styles.chartUnit}>
            <span>{GROUP_UNIT[group]}</span>
            <span>
              {zoom
                ? `聚焦视窗 · KPI 仍统计完整 ${range}`
                : `完整 ${range} · KPI 始终统计全区间`}
            </span>
          </div>

          <div className={styles.chartWrap} ref={wrapRef}>
            <svg
              className={styles.trendSvg}
              viewBox={`0 0 ${geometry.width} ${geometry.height}`}
              preserveAspectRatio="none"
              role="img"
              aria-label="性能趋势"
              onPointerMove={(event) => {
                if (!windowRows.length) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const x =
                  ((event.clientX - rect.left) / (rect.width || geometry.width)) *
                  geometry.width;
                if (x < geometry.left || x > geometry.right) {
                  setHover(null);
                  return;
                }
                const ratio = (x - geometry.left) / (geometry.right - geometry.left);
                setHover(
                  Math.max(
                    0,
                    Math.min(
                      windowRows.length - 1,
                      Math.round(ratio * (windowRows.length - 1)),
                    ),
                  ),
                );
              }}
              onPointerLeave={() => setHover(null)}
            >
              <defs>
                {activeKeys.map((key) => (
                  <linearGradient
                    key={key}
                    id={`detail-fill-${key}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop stopColor={META[key].color} stopOpacity="0.12" />
                    <stop offset="1" stopColor={META[key].color} stopOpacity="0" />
                  </linearGradient>
                ))}
              </defs>

              {[0, 25, 50, 75, 100].map((step) => {
                const value = (geometry.ceiling * step) / 100;
                const y =
                  geometry.bottom -
                  (value / geometry.ceiling) * (geometry.bottom - geometry.top);
                return (
                  <g key={step}>
                    <line
                      x1={geometry.left}
                      y1={y}
                      x2={geometry.right}
                      y2={y}
                      stroke="#edf0f4"
                      strokeDasharray="3 4"
                    />
                    <text
                      x={geometry.left - 10}
                      y={y + 4}
                      textAnchor="end"
                      fill="#727b8b"
                      fontSize="11"
                    >
                      {group === "overview"
                        ? Math.round(value)
                        : value < 1
                          ? value.toFixed(2)
                          : value.toFixed(1)}
                    </text>
                  </g>
                );
              })}

              {refLine ? (
                <g>
                  <line
                    x1={geometry.left}
                    y1={
                      geometry.bottom -
                      (refLine.value / geometry.ceiling) *
                        (geometry.bottom - geometry.top)
                    }
                    x2={geometry.right}
                    y2={
                      geometry.bottom -
                      (refLine.value / geometry.ceiling) *
                        (geometry.bottom - geometry.top)
                    }
                    stroke="#d99179"
                    strokeOpacity="0.65"
                    strokeDasharray="5 4"
                  />
                  <rect
                    x={geometry.right - refLine.width}
                    y={
                      geometry.bottom -
                      (refLine.value / geometry.ceiling) *
                        (geometry.bottom - geometry.top) -
                      16
                    }
                    width={refLine.width}
                    height="15"
                    fill="#fff"
                    opacity="0.9"
                  />
                  <text
                    x={geometry.right}
                    y={
                      geometry.bottom -
                      (refLine.value / geometry.ceiling) *
                        (geometry.bottom - geometry.top) -
                      5
                    }
                    textAnchor="end"
                    fill="#b77b66"
                    fontSize="11"
                  >
                    {refLine.label}
                  </text>
                </g>
              ) : null}

              {Array.from({ length: xTickCount }, (_, index) => {
                const ratio = index / (xTickCount - 1);
                const x = geometry.left + (geometry.right - geometry.left) * ratio;
                const stamp = axisFrom + (axisTo - axisFrom) * ratio;
                return (
                  <g key={`tick-${index}`}>
                    <line
                      x1={x}
                      y1={geometry.top}
                      x2={x}
                      y2={geometry.bottom}
                      stroke="#f3f5f8"
                    />
                    <text
                      x={x}
                      y={geometry.height - 12}
                      textAnchor={
                        index === 0 ? "start" : index === xTickCount - 1 ? "end" : "middle"
                      }
                      fill="#727b8b"
                      fontSize="11"
                    >
                      {tickTime(stamp)}
                    </text>
                  </g>
                );
              })}

              {[...activeKeys].reverse().map((key) => {
                const valid = windowRows.filter((row) => typeof row[key] === "number");
                if (!valid.length) return null;
                const path = valid
                  .map((row, index) => {
                    // 只有 1 个采样点时把它放在最右侧，与末端圆点重合
                    const ratio =
                      valid.length === 1 ? 1 : index / (valid.length - 1);
                    const x = geometry.left + (geometry.right - geometry.left) * ratio;
                    const y =
                      geometry.bottom -
                      ((row[key] as number) / geometry.ceiling) *
                        (geometry.bottom - geometry.top);
                    return `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
                  })
                  .join(" ");
                const last = valid[valid.length - 1][key] as number;
                const lastY =
                  geometry.bottom -
                  (last / geometry.ceiling) * (geometry.bottom - geometry.top);
                return (
                  <g key={key}>
                    {valid.length > 1 ? (
                      <path
                        d={`${path} L${geometry.right} ${geometry.bottom} L${geometry.left} ${geometry.bottom}Z`}
                        fill={`url(#detail-fill-${key})`}
                      />
                    ) : null}
                    <path
                      d={path}
                      fill="none"
                      stroke={META[key].color}
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                    <circle
                      cx={geometry.right}
                      cy={lastY}
                      r="3"
                      fill={META[key].color}
                      stroke="#fff"
                      strokeWidth="1.5"
                    />
                  </g>
                );
              })}

              {hoverX !== null && pointed ? (
                <g>
                  <line
                    x1={hoverX}
                    y1={geometry.top}
                    x2={hoverX}
                    y2={geometry.bottom}
                    stroke="#b7c1ce"
                    strokeDasharray="3 3"
                  />
                  {activeKeys.map((key) => {
                    const value = pointed[key];
                    if (typeof value !== "number") return null;
                    return (
                      <circle
                        key={key}
                        cx={hoverX}
                        cy={
                          geometry.bottom -
                          (value / geometry.ceiling) * (geometry.bottom - geometry.top)
                        }
                        r="3.5"
                        fill={META[key].color}
                        stroke="#fff"
                        strokeWidth="1.7"
                      />
                    );
                  })}
                </g>
              ) : null}
            </svg>

            {!windowRows.length && !loading ? (
              <div className={styles.chartEmpty}>
                <Activity size={24} />
                <span>节点离线 · 暂无历史采样</span>
                <small>缺测不记为 0，配置仍可查看</small>
              </div>
            ) : null}

            {hover !== null && pointed ? (
              <div className={styles.chartTooltip} style={{ left: tooltipLeft }}>
                <div className={styles.tooltipTitle}>
                  {dateTime(pointed.t)} · 实时采样
                </div>
                {activeKeys.map((key) => (
                  <div key={key} className={styles.tooltipRow}>
                    <i className={styles.dot} style={{ color: META[key].color }} />
                    {META[key].label}
                    <strong>
                      {typeof pointed[key] === "number"
                        ? `${fmt(pointed[key] as number, key === "load" ? 2 : 1)} ${META[key].unit}`
                        : "—"}
                    </strong>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className={styles.zoomControls}>
            <span>趋势视窗</span>
            <label>
              <span>起点</span>
              <input
                type="range"
                min={0}
                max={Math.max(rows.length - 1, 0)}
                value={zoom?.start ?? 0}
                disabled={rows.length < MIN_ZOOM_POINTS}
                onChange={(event) =>
                  setZoom({
                    start: Math.min(Number(event.target.value), (zoom?.end ?? rows.length - 1) - 2),
                    end: zoom?.end ?? rows.length - 1,
                  })
                }
              />
            </label>
            <label>
              <span>终点</span>
              <input
                type="range"
                min={0}
                max={Math.max(rows.length - 1, 0)}
                value={zoom?.end ?? Math.max(rows.length - 1, 0)}
                disabled={rows.length < MIN_ZOOM_POINTS}
                onChange={(event) =>
                  setZoom({
                    start: zoom?.start ?? 0,
                    end: Math.max(Number(event.target.value), (zoom?.start ?? 0) + 2),
                  })
                }
              />
            </label>
            <span className={styles.mono}>
              {rows.length < MIN_ZOOM_POINTS
                ? `${rows.length} 点 · 数据不足`
                : `${windowRows.length} / ${rows.length} 点`}
            </span>
          </div>

          <div className={styles.heatSection}>
            <div className={styles.heatHead}>
              <span className={styles.heatTitle}>CPU 时间热力条</span>
              <span className={styles.heatMeta}>
                {status === "offline"
                  ? `0 有效 / ${expected} 预期采样点 · 灰色为缺测`
                  : buckets.length === expected
                    ? `${expected} 个采样格 · 点击聚焦趋势`
                    : `${expected} 个采样点 → ${buckets.length} 个聚合桶 · 点击聚焦`}
              </span>
            </div>

            <div className={styles.heatStrip}>
              {buckets.map((bucket) => {
                const selected =
                  focusTs !== null &&
                  focusTs >= bucket.startT &&
                  focusTs <= bucket.endT;
                return (
                  <button
                    key={bucket.index}
                    type="button"
                    className={`${styles.heatCell} ${bucket.count ? "" : styles.heatEmpty} ${selected ? styles.heatSelected : ""}`}
                    style={
                      {
                        "--heat-color":
                          bucket.level === null
                            ? "#edf0f5"
                            : HEAT_COLORS[bucket.level],
                      } as CSSProperties
                    }
                    title={
                      bucket.count
                        ? `${tickTime(bucket.coverageStartT)} 至 ${tickTime(bucket.coverageEndT)}，CPU 均值 ${pct(bucket.avg)}，${bucket.count} 个采样点`
                        : `${tickTime(bucket.coverageStartT)} 至 ${tickTime(bucket.coverageEndT)}，未采到，0 个有效采样点`
                    }
                    onClick={() => focusBucket(bucket.startT, bucket.endT)}
                  />
                );
              })}
            </div>

            <div className={styles.heatAxis}>
              <span>
                {sampleEnd
                  ? tickTime(sampleEnd - RANGE_SECONDS[range])
                  : "—"}
              </span>
              <span>
                {sampleEnd
                  ? tickTime(sampleEnd - RANGE_SECONDS[range] / 2)
                  : "—"}
              </span>
              <span>{sampleEnd ? tickTime(sampleEnd) : "—"}</span>
            </div>

            <div className={styles.heatLegend}>
              <span>低</span>
              {["<20%", "20–39%", "40–59%", "60–79%", "≥80%"].map((label, index) => (
                <span key={label}>
                  <i
                    className={styles.heatSwatch}
                    style={{ "--heat-color": HEAT_COLORS[index] } as CSSProperties}
                  />
                  {label}
                </span>
              ))}
              <span>高</span>
              <span>
                <i className={`${styles.heatSwatch} ${styles.heatSwatchEmpty}`} />
                缺测
              </span>
            </div>
          </div>
        </section>

        <aside className={styles.panel}>
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle}>节点信息与负载</h2>
            <Info size={15} />
          </div>

          <div className={styles.loadBlock}>
            <div className={styles.loadTitle}>
              <span>系统负载</span>
              <span>无量纲</span>
            </div>
            <div className={styles.loadMain}>
              <strong className={styles.loadNumber}>{fmt(stats.load.latest, 2)}</strong>
              <div className={styles.perCore}>
                <strong>{fmt(perCore, 2)}</strong>
                <span>每核负载 / {cores} 核</span>
              </div>
            </div>
            <div className={styles.track}>
              <span
                style={{
                  width: `${perCore === null ? 0 : Math.min(100, Math.max(0, perCore * 100))}%`,
                  background: loadTone.stroke,
                }}
              />
            </div>
            <div className={styles.loadCaption}>
              {perCore === null
                ? "离线 · 无有效负载采样"
                : `load ÷ ${cores} · 每核 ${perCore >= 1 ? "≥1.00" : "<1.00"}`}
            </div>
          </div>

          <dl className={styles.nodeDetails}>
            {detailRows.map(([label, value]) => (
              <div key={label} className={styles.detailRow}>
                <dt>{label}</dt>
                <dd className={label === "地域" || label === "私网 IP" ? styles.mono : ""}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          <div className={styles.infoSeparator} />

          <div className={styles.observations}>
            <h3>
              <Sparkles size={14} />
              监控观察
              <span className={styles.muted}>· 规则计算</span>
            </h3>
            {observations.map(([title, text, color]) => (
              <div key={title} className={styles.observation}>
                <i className={styles.dot} style={{ color }} />
                <div>
                  <strong>{title}</strong>
                  <br />
                  {text}
                </div>
              </div>
            ))}
            <p className={styles.observationNote}>
              全区间真实序列 · 规则计算
              <br />
              不含进程 / 容器数据，不调用 AI。
            </p>
          </div>
        </aside>
      </div>

      <div className={styles.bottomGrid}>
        <section className={`${styles.panel} ${styles.miniPanel}`}>
          <div className={styles.miniHead}>
            <span>磁盘使用情况</span>
            <HardDrive size={14} />
          </div>
          <div className={styles.miniMain}>
            <strong>{diskUsage === null ? "—" : `${fmt(diskUsage)}%`}</strong>
            <span>{diskUsage === null ? "离线 · 无采样" : `剩余 ${pct(100 - diskUsage)}`}</span>
          </div>
          <div className={styles.track}>
            <span
              style={{
                width: `${diskUsage === null ? 0 : Math.min(100, diskUsage)}%`,
                background: levelTone(diskUsage).stroke,
              }}
            />
          </div>
          <p className={styles.miniCaption}>
            {diskUsage === null ? "缺测不记为 0" : "磁盘使用率取自监控采样"}
          </p>
        </section>

        <section className={`${styles.panel} ${styles.miniPanel}`}>
          <div className={styles.miniHead}>
            <span>采样与统计口径</span>
            <Clock size={14} />
          </div>
          <div className={styles.miniMain}>
            <strong>
              {rows.length} / {expected}
            </strong>
            <span>每 {RANGE_STEP[range]} 秒 / 点</span>
          </div>
          <p className={styles.miniCaption}>
            {status === "offline"
              ? "0 个有效点 · 缺测不记为 0"
              : "含首尾端点 · 聚焦不改变 KPI"}
          </p>
        </section>

        <section className={`${styles.panel} ${styles.miniPanel}`}>
          <div className={styles.miniHead}>
            <span>最近采样事件</span>
            <span className={styles.badgeNeutral}>实时</span>
          </div>
          <div className={styles.eventInline}>
            <i className={styles.dot} style={{ color: statusTone.stroke }} />
            <div>
              <strong>
                {status === "offline"
                  ? "节点离线 · 缺少采样"
                  : status === "critical"
                    ? "当前资源高位"
                    : status === "warning"
                      ? "当前资源需关注"
                      : "节点指标正常"}
              </strong>
              <p>
                {status === "offline"
                  ? "该节点暂无监控采样。"
                  : status === "critical"
                    ? "当前 CPU / 内存至少一项 ≥90%"
                    : status === "warning"
                      ? "当前有指标 ≥80%"
                      : "当前采样未触发 80% 资源阈值"}
              </p>
              <time className={styles.mono}>
                {sampleEnd ? `${dateTime(sampleEnd)} · 实时采样` : "—"}
              </time>
            </div>
          </div>
        </section>
      </div>

      <footer className={styles.footer}>
        <i className={styles.dot} />
        <span>{instance.instance_id}</span>
        <span>·</span>
        <span>
          {range} / {rows.length} 个端点
        </span>
        <span className={styles.footerRight}>
          <Copy size={11} /> 数据来自腾讯云监控
        </span>
      </footer>
    </div>
  );
}
