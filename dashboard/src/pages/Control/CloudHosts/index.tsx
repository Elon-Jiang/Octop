import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  App,
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import {
  Cloud,
  ExternalLink,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react";
import { request } from "../../../api/request";
import { useCvmOpsExpert } from "../../../hooks/useCvmOpsExpert";
import CloudAiPanel from "./components/CloudAiPanel";
import ClusterDashboard from "./components/ClusterDashboard";
import NodeDetailView from "./components/NodeDetailView";
import NodeGrid, {
  NodeStatusSummary,
  type NodeHealth,
  type NodeLoad,
} from "./components/NodeOverview";
import CloudOverviewBoard, {
  type BoardInstance,
  type TrendPoint,
} from "./components/CloudOverviewBoard";
import styles from "./index.module.less";

type CloudStatus = {
  authorized: boolean;
  state: "valid" | "expired" | "missing";
  expires_at?: number;
  remaining_seconds?: number;
  can_refresh?: boolean;
  error?: string;
};

type Region = { id: string; name: string };

type Instance = {
  instance_id: string;
  name: string;
  region: string;
  zone: string;
  state: string;
  os_name: string;
  private_ips: string[];
  public_ips: string[];
  created_at: string;
  cpu: number;
  memory_gb: number;
};

type MetricPoint = { t: number; v: number };
type MetricsPayload = {
  instance_id: string;
  region: string;
  series: Record<string, MetricPoint[]>;
};

// period 单位秒；腾讯云单次最多返回 1440 个点，长周期自动降采样
const METRIC_RANGES = {
  "1h": { minutes: 60, period: 60, gran: "cloud.gran1m" },
  "24h": { minutes: 1440, period: 300, gran: "cloud.gran5m" },
  "7d": { minutes: 10080, period: 3600, gran: "cloud.gran1h" },
} as const;

type MetricRange = keyof typeof METRIC_RANGES;

const STATE_COLOR: Record<string, string> = {
  RUNNING: "success",
  STOPPED: "default",
  STARTING: "processing",
  STOPPING: "processing",
  REBOOTING: "processing",
};

function formatRemaining(seconds?: number): string {
  if (!seconds || seconds <= 0) return "0 分钟";
  if (seconds < 60) return `${Math.floor(seconds)} 秒`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

/** Live credential countdown: ticks every second and asks for a silent renew on expiry. */
function CredentialBadge({
  status,
  busy,
  onExpire,
  onRenew,
}: {
  status: CloudStatus | null;
  busy: boolean;
  onExpire: () => void;
  onRenew: () => void;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now() / 1000);
  const fired = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const expiresAt = status?.expires_at;
  const remaining =
    expiresAt != null
      ? Math.max(0, Math.floor(expiresAt - now))
      : Math.max(0, Math.floor(status?.remaining_seconds ?? 0));

  useEffect(() => {
    if (!status?.authorized || expiresAt == null) return;
    if (remaining > 0) {
      fired.current = false;
      return;
    }
    if (fired.current) return;
    fired.current = true;
    onExpire();
  }, [remaining, expiresAt, status?.authorized, onExpire]);

  if (!status?.authorized) {
    return <Tag color="default">{t("cloud.notAuthorized")}</Tag>;
  }

  const critical = remaining <= 60;
  const urgent = remaining <= 300;
  return (
    <button
      type="button"
      className={styles.credentialChip}
      data-tone={critical ? "danger" : urgent ? "warning" : "ok"}
      title={t("cloud.renewHint")}
      disabled={busy}
      onClick={onRenew}
    >
      <span className={styles.credentialDot} />
      <span>
        {t("cloud.authorized")} · {formatRemaining(remaining)}
      </span>
      <RefreshCw
        size={11}
        className={busy ? styles.credentialSpinning : styles.credentialIcon}
      />
    </button>
  );
}

/** Compact usage bar for the all-nodes table. */
function MiniBar({ value }: { value: number | null | undefined }) {
  if (value == null) {
    return <span className={styles.miniValue}>—</span>;
  }
  const clamped = Math.max(0, Math.min(100, value));
  const color =
    clamped >= 85 ? "#df5665" : clamped >= 60 ? "#ea580c" : "#10b981";
  return (
    <div className={styles.miniBar}>
      <div className={styles.miniBarTrack}>
        <div
          className={styles.miniBarFill}
          style={{ width: `${clamped}%`, background: color }}
        />
      </div>
      <span className={styles.miniValue}>{clamped.toFixed(0)}%</span>
    </div>
  );
}

export default function CloudHostsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [selectedRegions, setSelectedRegions] = useState<string[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Instance | null>(null);
  const [metrics, setMetrics] = useState<MetricsPayload | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [range, setRange] = useState<MetricRange>("1h");
  const [focusTs, setFocusTs] = useState<number | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "nodes">("overview");
  const [keyword, setKeyword] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [authUrl, setAuthUrl] = useState("");
  const [code, setCode] = useState("");
  /** OAuth state issued by /cloud/authorize; must be echoed back on callback. */
  const [authState, setAuthState] = useState("");
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await request<CloudStatus>("/cloud/status"));
    } catch {
      setStatus({ authorized: false, state: "missing" });
    }
  }, []);

  const loadRegions = useCallback(async () => {
    try {
      const result = await request<{ regions: Region[] }>("/cloud/regions");
      setRegions(result.regions);
    } catch {
      setRegions([]);
    }
  }, []);

  const loadInstances = useCallback(
    async (targets?: string[]) => {
      setLoading(true);
      try {
        const query = (targets && targets.length ? targets : selectedRegions)
          .map((region) => `region=${encodeURIComponent(region)}`)
          .join("&");
        const result = await request<{ instances: Instance[] }>(
          `/cloud/instances${query ? `?${query}` : ""}`,
        );
        setInstances(result.instances);
        setSelected((current) =>
          current
            ? result.instances.find(
                (item) =>
                  item.instance_id === current.instance_id &&
                  item.region === current.region,
              ) ?? null
            : null,
        );
      } catch (error) {
        message.error(
          error instanceof Error ? error.message : t("cloud.loadFailed"),
        );
        setInstances([]);
      } finally {
        setLoading(false);
      }
    },
    [message, selectedRegions, t],
  );

  const loadMetrics = useCallback(
    async (instance: Instance, window: MetricRange) => {
      const conf = METRIC_RANGES[window];
      setMetricsLoading(true);
      try {
        setMetrics(
          await request<MetricsPayload>(
            `/cloud/metrics?region=${encodeURIComponent(
              instance.region,
            )}&instance_id=${encodeURIComponent(
              instance.instance_id,
            )}&minutes=${conf.minutes}&period=${conf.period}`,
          ),
        );
      } catch {
        setMetrics(null);
      } finally {
        setMetricsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void (async () => {
      await loadStatus();
      const current = await request<CloudStatus>("/cloud/status").catch(
        () => null,
      );
      if (current?.authorized) {
        await loadRegions();
        await loadInstances();
      }
    })();
  }, [loadInstances, loadRegions, loadStatus]);

  useEffect(() => {
    setFocusTs(null);
    if (selected) void loadMetrics(selected, range);
    else setMetrics(null);
  }, [selected, range, loadMetrics]);

  const startAuth = async () => {
    setBusy(true);
    try {
      const result = await request<{ auth_url: string; state: string }>(
        "/cloud/authorize",
        { method: "POST" },
      );
      setAuthUrl(result.auth_url);
      setAuthState(result.state || "");
      window.open(result.auth_url, "_blank", "noopener,noreferrer");
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("cloud.authFailed"));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      message.warning(t("cloud.pasteFirst"));
      return;
    }
    // state 只存在于本次页面生命周期：刷新后旧 state 必然校验失败，
    // 提前拦下并引导重新授权，避免用户看到无意义的 409。
    if (!authState) {
      message.warning(
        t("cloud.authExpired", "授权会话已失效，请重新点击「授权腾讯云」"),
      );
      return;
    }
    setBusy(true);
    try {
      await request("/cloud/callback", {
        method: "POST",
        body: JSON.stringify({
          code: trimmed,
          state: authState || undefined,
        }),
      });
      message.success(t("cloud.authSuccess"));
      setAuthOpen(false);
      setAuthUrl("");
      setAuthState("");
      setCode("");
      await loadStatus();
      await loadRegions();
      await loadInstances();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("cloud.authFailed"));
    } finally {
      setBusy(false);
    }
  };

  const submitFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        message.warning(t("cloud.clipboardEmpty"));
        return;
      }
      setCode(text.trim());
      await submitCode(text);
    } catch {
      message.info(t("cloud.clipboardDenied"));
    }
  };

  const importFromTccli = async () => {
    setBusy(true);
    try {
      await request("/cloud/import-from-tccli", { method: "POST" });
      message.success(t("cloud.importSuccess"));
      setAuthOpen(false);
      await loadStatus();
      await loadRegions();
      await loadInstances();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("cloud.importFailed"));
    } finally {
      setBusy(false);
    }
  };

  const refreshCredential = async () => {
    setBusy(true);
    try {
      const next = await request<CloudStatus>("/cloud/refresh", {
        method: "POST",
      });
      setStatus(next);
      if (next.authorized) {
        message.success(t("cloud.refreshSuccess"));
      } else {
        message.warning(t("cloud.refreshFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (instance: Instance, action: string) => {
    try {
      await request("/cloud/action", {
        method: "POST",
        body: JSON.stringify({
          region: instance.region,
          instance_id: instance.instance_id,
          action,
        }),
      });
      message.success(t("cloud.actionAccepted"));
      await loadInstances();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("cloud.actionFailed"));
    }
  };

  const [clusterMetrics, setClusterMetrics] = useState<
    Record<string, Record<string, number>>
  >({});
  const [clusterLoading, setClusterLoading] = useState(false);
  const [metricsSampledAt, setMetricsSampledAt] = useState(0);

  const loadClusterMetrics = useCallback(async () => {
    if (!instances.length) {
      setClusterMetrics({});
      return;
    }
    setClusterLoading(true);
    try {
      const payload = await request<{
        sampled_at: number;
        items: Record<string, Record<string, number>>;
      }>("/cloud/metrics/batch", {
        method: "POST",
        body: JSON.stringify({
          instances: instances.map((row) => ({
            region: row.region,
            instance_id: row.instance_id,
          })),
        }),
      });
      setClusterMetrics(payload.items ?? {});
      setMetricsSampledAt(payload.sampled_at ?? 0);
    } catch {
      setClusterMetrics({});
    } finally {
      setClusterLoading(false);
    }
  }, [instances]);

  const [clusterTrend, setClusterTrend] = useState<{
    sampled_at: number;
    sampled: number;
    total: number;
    points: TrendPoint[];
  }>({ sampled_at: 0, sampled: 0, total: 0, points: [] });
  const [trendLoading, setTrendLoading] = useState(false);

  // 集群趋势 = 抽样实例的真实时间序列按时间点求均值，后端聚合，前端不插值
  const loadClusterTrend = useCallback(async () => {
    if (!instances.length) {
      setClusterTrend({ sampled_at: 0, sampled: 0, total: 0, points: [] });
      return;
    }
    setTrendLoading(true);
    try {
      const payload = await request<{
        sampled_at: number;
        sampled: number;
        total: number;
        points: TrendPoint[];
      }>("/cloud/metrics/cluster-trend", {
        method: "POST",
        body: JSON.stringify({
          instances: instances.map((row) => ({
            region: row.region,
            instance_id: row.instance_id,
          })),
          minutes: 60,
          period: 60,
          max_instances: 12,
        }),
      });
      setClusterTrend({
        sampled_at: payload.sampled_at ?? 0,
        sampled: payload.sampled ?? 0,
        total: payload.total ?? 0,
        points: payload.points ?? [],
      });
    } catch {
      setClusterTrend({ sampled_at: 0, sampled: 0, total: 0, points: [] });
    } finally {
      setTrendLoading(false);
    }
  }, [instances]);

  const handleExpire = useCallback(() => {
    void loadStatus();
  }, [loadStatus]);

  const filteredInstances = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    if (!query) return instances;
    return instances.filter((row) =>
      [
        row.name,
        row.instance_id,
        row.region,
        row.zone,
        row.private_ips[0],
        row.public_ips[0],
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [instances, keyword]);

  // KPI 跟随搜索范围，避免"顶部写 486、左侧只剩 2 台"的口径不一致
  const runningCount = filteredInstances.filter(
    (row) => row.state === "RUNNING",
  ).length;
  const stoppedCount = filteredInstances.filter(
    (row) => row.state === "STOPPED",
  ).length;
  const scopeFiltered = keyword.trim().length > 0;

  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("octop:cloud:sidebar") !== "0";
  });

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      window.localStorage.setItem("octop:cloud:sidebar", next ? "1" : "0");
      return next;
    });
  }, []);

  const [nodeView, setNodeView] = useState<"card" | "table">(() => {
    if (typeof window === "undefined") return "card";
    return window.localStorage.getItem("octop:cloud:node-view") === "table"
      ? "table"
      : "card";
  });

  const switchNodeView = useCallback((next: "card" | "table") => {
    setNodeView(next);
    window.localStorage.setItem("octop:cloud:node-view", next);
  }, []);

  const [boardMetric, setBoardMetric] = useState<"health" | "cpu" | "mem">(
    "health",
  );

  // 节点总览数据：只展示真实采样值，缺失一律留空而不是编造数字
  const nodeRows = useMemo<NodeLoad[]>(
    () =>
      filteredInstances.map((row) => {
        const metric = clusterMetrics[row.instance_id] ?? {};
        const stopped = row.state === "STOPPED";
        const read = (key: string): number | null => {
          if (stopped) return null;
          const raw = metric[key];
          return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
        };

        const cpu = read("cpu");
        const mem = read("mem");
        const disk = read("disk_usage");
        const netIn = read("net_in");
        const netOut = read("net_out");
        const load = read("load");

        const health: NodeHealth = stopped
          ? "offline"
          : cpu === null && mem === null
            ? "unknown"
            : (cpu ?? 0) >= 80 || (mem ?? 0) >= 88 || (disk ?? 0) >= 88
              ? "alert"
              : "online";

        return {
          id: `${row.region}:${row.instance_id}`,
          name: row.name,
          ip: row.private_ips[0] || row.public_ips[0] || row.instance_id,
          health,
          rawState: row.state,
          cpu,
          mem,
          disk,
          netIn,
          netOut,
          cores: row.cpu || 1,
          load,
        };
      }),
    [filteredInstances, clusterMetrics],
  );

  // 多节点聚合指标：仅统计已采到数据的节点，供集群仪表盘使用
  const clusterNodes = useMemo(
    () =>
      filteredInstances
        .map((row) => {
          const metric = clusterMetrics[row.instance_id] ?? {};
          return {
            cpu: metric.cpu,
            mem: metric.mem,
            disk: metric.disk_usage,
            load: metric.load,
            netIn: metric.net_in,
            netOut: metric.net_out,
            cores: row.cpu || 1,
          };
        })
        .filter((node) => Number.isFinite(node.cpu)),
    [filteredInstances, clusterMetrics],
  );

  // 总览只看集群排行，不再依赖左侧选择
  const hotNodes = useMemo(
    () =>
      filteredInstances
        .map((row) => ({
          row,
          cpu: clusterMetrics[row.instance_id]?.cpu,
        }))
        .filter((item) => Number.isFinite(item.cpu))
        .sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0))
        .slice(0, 5),
    [filteredInstances, clusterMetrics],
  );

  const authorized = Boolean(status?.authorized);

  // 授权后自动就绪「腾讯云运维专家」，无需用户去专家市场手动添加
  const {
    agentId: opsAgentId,
    ensuring: opsEnsuring,
    ensureError: opsExpertError,
  } = useCvmOpsExpert(authorized);

  useEffect(() => {
    if (!authorized || activeTab !== "overview") return;
    void loadClusterMetrics();
    void loadClusterTrend();
  }, [authorized, activeTab, loadClusterMetrics, loadClusterTrend]);

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <Space wrap>
          <CredentialBadge
            status={status}
            busy={busy}
            onExpire={handleExpire}
            onRenew={() => void refreshCredential()}
          />
          <Select
            mode="multiple"
            allowClear
            style={{ minWidth: 260 }}
            placeholder={t("cloud.regionPlaceholder")}
            value={selectedRegions}
            options={regions.map((region) => ({
              value: region.id,
              label: `${region.name} (${region.id})`,
            }))}
            onChange={(value) => setSelectedRegions(value)}
            disabled={!authorized}
          />
          <Button
            icon={<RefreshCw size={14} />}
            loading={loading}
            disabled={!authorized}
            onClick={() => void loadInstances()}
          >
            {t("cloud.refresh")}
          </Button>
        </Space>
        <Space>
          <Button
            icon={<Sparkles size={14} />}
            type={aiOpen ? "primary" : "default"}
            onClick={() => setAiOpen((value) => !value)}
          >
            {t("cloud.aiAssistant")}
          </Button>
          {authorized ? (
            <Button
              icon={<KeyRound size={14} />}
              onClick={() => setAuthOpen(true)}
            >
              {t("cloud.manageAuth")}
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<Cloud size={14} />}
              onClick={() => setAuthOpen(true)}
            >
              {t("cloud.authorize")}
            </Button>
          )}
        </Space>
      </div>

      {!authorized ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("cloud.emptyDescription")}
          style={{ marginTop: 48 }}
        >
          <Button type="primary" onClick={() => setAuthOpen(true)}>
            {t("cloud.authorize")}
          </Button>
        </Empty>
      ) : (
        <>
          <div className={styles.body}>
            <aside
              className={sidebarOpen ? styles.sidebar : styles.sidebarRail}
            >
              {sidebarOpen ? (
                <>
              <div className={styles.sidebarHead}>
                <span className={styles.sidebarTitle}>
                  {t("cloud.nodeRange")}
                </span>
                <span className={styles.sidebarCount}>
                  {filteredInstances.length}
                </span>
                <button
                  type="button"
                  className={styles.railBtn}
                  onClick={toggleSidebar}
                  title={t("cloud.collapseSidebar")}
                  aria-label={t("cloud.collapseSidebar")}
                >
                  <PanelLeftClose size={14} />
                </button>
              </div>
              <Input
                size="small"
                allowClear
                value={keyword}
                prefix={<Search size={13} />}
                placeholder={t("cloud.searchNode")}
                onChange={(event) => setKeyword(event.target.value)}
              />
              <div className={styles.nodeList}>
                <button
                  type="button"
                  className={
                    selected ? styles.nodeItem : styles.nodeItemActive
                  }
                  onClick={() => {
                    setSelected(null);
                    setActiveTab("nodes");
                  }}
                >
                  <span className={styles.nodeAllIcon}>▦</span>
                  <span className={styles.nodeText}>
                    <span className={styles.nodeName}>
                      {t("cloud.allNodes")}
                    </span>
                    <span className={styles.nodeMeta}>
                      {t("cloud.kpiRunning")} {runningCount} ·{" "}
                      {t("cloud.kpiStopped")} {stoppedCount}
                    </span>
                  </span>
                </button>
                {filteredInstances.length ? (
                  filteredInstances.map((row) => {
                    const active =
                      selected?.instance_id === row.instance_id &&
                      selected?.region === row.region;
                    return (
                      <button
                        key={`${row.region}:${row.instance_id}`}
                        type="button"
                        className={
                          active ? styles.nodeItemActive : styles.nodeItem
                        }
                        onClick={() => {
                          setSelected(row);
                          setActiveTab("nodes");
                        }}
                      >
                        <span
                          className={
                            row.state === "RUNNING"
                              ? styles.nodeDotOn
                              : styles.nodeDotOff
                          }
                        />
                        <span className={styles.nodeText}>
                          <span className={styles.nodeName}>{row.name}</span>
                          <span className={styles.nodeMeta}>
                            {row.private_ips[0] ||
                              row.public_ips[0] ||
                              row.instance_id}
                          </span>
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <span className={styles.nodeEmpty}>
                    {instances.length
                      ? t("cloud.searchEmpty")
                      : t("cloud.emptyNoInstance")}
                  </span>
                )}
              </div>
                </>
              ) : (
                <button
                  type="button"
                  className={styles.railBtn}
                  onClick={toggleSidebar}
                  title={t("cloud.expandSidebar")}
                  aria-label={t("cloud.expandSidebar")}
                >
                  <PanelLeftOpen size={14} />
                </button>
              )}
            </aside>
            <div className={styles.content}>
              <Tabs
                size="small"
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key as "overview" | "nodes")}
                items={[
                  { key: "overview", label: t("cloud.tabOverview") },
                  { key: "nodes", label: t("cloud.tabNodes") },
                ]}
              />
              <div className={styles.main}>
          {scopeFiltered ? (
            <div className={styles.scopeBar}>
              <Search size={13} />
              <span>
                {t("cloud.scopeFiltered", {
                  keyword: keyword.trim(),
                  shown: filteredInstances.length,
                  total: instances.length,
                })}
              </span>
            </div>
          ) : null}
          <div
            className={
              activeTab === "nodes" && !selected
                ? styles.nodesPane
                : styles.hiddenPane
            }
          >
            <NodeStatusSummary
              rows={nodeRows}
              right={
                <Segmented
                  size="small"
                  value={nodeView}
                  onChange={(value) =>
                    switchNodeView(value as "card" | "table")
                  }
                  options={[
                    { label: t("cloud.viewCard"), value: "card" },
                    { label: t("cloud.viewTable"), value: "table" },
                  ]}
                />
              }
            />
            {nodeView === "card" ? (
              <NodeGrid
                rows={nodeRows}
                onSelect={(node) => {
                  const target = filteredInstances.find(
                    (row) => `${row.region}:${row.instance_id}` === node.id,
                  );
                  if (target) setSelected(target);
                }}
              />
            ) : (
              <div className={styles.tableWrap}>
            <Table<Instance>
              size="small"
              rowKey={(row) => `${row.region}:${row.instance_id}`}
              dataSource={filteredInstances}
              loading={loading}
              pagination={{ pageSize: 20, showSizeChanger: true }}
              scroll={{ x: 900 }}
              rowClassName={(row) =>
                selected?.instance_id === row.instance_id &&
                selected?.region === row.region
                  ? styles.rowActive
                  : ""
              }
              onRow={(row) => ({
                onClick: () => setSelected(row),
                style: { cursor: "pointer" },
              })}
              columns={[
                {
                  title: t("cloud.colName"),
                  dataIndex: "name",
                  render: (value: string, row) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{value}</Typography.Text>
                      <Typography.Text
                        type="secondary"
                        className={styles.mono}
                      >
                        {row.instance_id}
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: t("cloud.colRegion"),
                  width: 170,
                  render: (_, row) => (
                    <span className={styles.mono}>
                      {`${row.region} / ${row.zone || "-"}`}
                    </span>
                  ),
                },
                {
                  title: t("cloud.colState"),
                  width: 110,
                  render: (_, row) => (
                    <Tag color={STATE_COLOR[row.state] || "default"}>
                      {row.state || "UNKNOWN"}
                    </Tag>
                  ),
                },
                {
                  title: t("cloud.colSpec"),
                  width: 130,
                  render: (_, row) => (
                    <span className={styles.mono}>
                      {`${row.cpu} 核 / ${row.memory_gb} GB`}
                    </span>
                  ),
                },
                {
                  title: t("cloud.colAddress"),
                  width: 170,
                  render: (_, row) => (
                    <span className={styles.mono}>
                      {row.public_ips[0] || row.private_ips[0] || "—"}
                    </span>
                  ),
                },
                {
                  title: t("cloud.colOS"),
                  width: 180,
                  ellipsis: true,
                  dataIndex: "os_name",
                },
                {
                  title: t("cloud.colActions"),
                  width: 150,
                  render: (_, row) => (
                    <Space size={4} onClick={(event) => event.stopPropagation()}>
                      <Popconfirm
                        title={t("cloud.confirmStart")}
                        onConfirm={() => void runAction(row, "start")}
                        disabled={row.state === "RUNNING"}
                      >
                        <Button
                          size="small"
                          type="text"
                          icon={<PlayCircle size={15} />}
                          disabled={row.state === "RUNNING"}
                        />
                      </Popconfirm>
                      <Popconfirm
                        title={t("cloud.confirmStop")}
                        onConfirm={() => void runAction(row, "stop")}
                        disabled={row.state === "STOPPED"}
                      >
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<PauseCircle size={15} />}
                          disabled={row.state === "STOPPED"}
                        />
                      </Popconfirm>
                      <Popconfirm
                        title={t("cloud.confirmReboot")}
                        onConfirm={() => void runAction(row, "reboot")}
                      >
                        <Button
                          size="small"
                          type="text"
                          icon={<RotateCcw size={15} />}
                        />
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
              </div>
            )}
          </div>

          <div
            className={
              activeTab === "nodes" ? styles.hiddenPane : styles.overviewPane
            }
          >
            <CloudOverviewBoard
              instances={filteredInstances as BoardInstance[]}
              clusterMetrics={clusterMetrics}
              regions={regions}
              metric={boardMetric}
              onMetricChange={setBoardMetric}
              onSelectNode={(row) => {
                setSelected(row as Instance);
                setActiveTab("nodes");
              }}
              trend={clusterTrend.points}
              trendSampled={clusterTrend.sampled}
              trendTotal={clusterTrend.total}
              trendLoading={trendLoading}
              sampledAt={clusterTrend.sampled_at || metricsSampledAt}
            />
          </div>
          <div
            className={
              activeTab === "nodes" && selected
                ? styles.detail
                : styles.hiddenPane
            }
          >
            {activeTab === "nodes" && selected ? (
              <NodeDetailView
                instance={selected}
                series={metrics?.series ?? {}}
                loading={metricsLoading}
                range={range}
                onRangeChange={(value) => setRange(value as MetricRange)}
                onBack={() => setSelected(null)}
                focusTs={focusTs}
                onFocusTs={setFocusTs}
              />
            ) : (
              <>
                <Spin spinning={clusterLoading}>
                  <ClusterDashboard nodes={clusterNodes} />
                </Spin>
                <div className={styles.blockTitle}>{t("cloud.hotNodes")}</div>
              <Table<Instance>
                size="small"
                rowKey={(row) => `${row.region}:${row.instance_id}`}
                dataSource={hotNodes.map((item) => item.row)}
                loading={clusterLoading}
                pagination={false}
                scroll={{ x: 780 }}
                onRow={(row) => ({
                  onClick: () => {
                    setSelected(row);
                    setActiveTab("nodes");
                  },
                  style: { cursor: "pointer" },
                })}
                columns={[
                  {
                    title: t("cloud.colName"),
                    render: (_, row) => (
                      <Space direction="vertical" size={0}>
                        <Typography.Text strong>{row.name}</Typography.Text>
                        <Typography.Text
                          type="secondary"
                          className={styles.mono}
                        >
                          {row.private_ips[0] ||
                            row.public_ips[0] ||
                            row.instance_id}
                        </Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: "CPU",
                    width: 150,
                    render: (_, row) => (
                      <MiniBar value={clusterMetrics[row.instance_id]?.cpu} />
                    ),
                  },
                  {
                    title: t("cloud.metricMem"),
                    width: 150,
                    render: (_, row) => (
                      <MiniBar value={clusterMetrics[row.instance_id]?.mem} />
                    ),
                  },
                  {
                    title: t("cloud.metricDisk"),
                    width: 150,
                    render: (_, row) => (
                      <MiniBar
                        value={clusterMetrics[row.instance_id]?.disk_usage}
                      />
                    ),
                  },
                  {
                    title: t("cloud.metricLoad"),
                    width: 120,
                    render: (_, row) => {
                      const load = clusterMetrics[row.instance_id]?.load;
                      return (
                        <span className={styles.mono}>
                          {load == null
                            ? "—"
                            : `${load.toFixed(2)} / ${row.cpu}`}
                        </span>
                      );
                    },
                  },
                  {
                    title: t("cloud.colState"),
                    width: 110,
                    render: (_, row) => (
                      <Tag color={STATE_COLOR[row.state] || "default"}>
                        {row.state || "UNKNOWN"}
                      </Tag>
                    ),
                  },
                ]}
              />
              </>
            )}
          </div>
          </div>
          {aiOpen ? (
            <CloudAiPanel
              instance={selected}
              preferredAgentId={opsAgentId}
              expertEnsuring={opsEnsuring}
              expertError={opsExpertError}
              onClose={() => setAiOpen(false)}
            />
          ) : null}
          </div>
          </div>
        </>
      )}

      <Modal
        open={authOpen}
        onCancel={() => setAuthOpen(false)}
        footer={null}
        width={520}
        title={t("cloud.authTitle")}
        destroyOnClose
      >
        {authorized ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Alert
              type="success"
              showIcon
              message={t("cloud.authorized")}
              description={`${t("cloud.remaining")} ${formatRemaining(
                status?.remaining_seconds,
              )}`}
            />
            <Space>
              <Button
                icon={<RefreshCw size={14} />}
                loading={busy}
                onClick={() => void refreshCredential()}
              >
                {t("cloud.renew")}
              </Button>
              <Button
                danger
                onClick={() => {
                  void request("/cloud", { method: "DELETE" }).then(() => {
                    setAuthOpen(false);
                    void loadStatus();
                    setInstances([]);
                  });
                }}
              >
                {t("cloud.logout")}
              </Button>
            </Space>
          </Space>
        ) : (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              message={t("cloud.authIntro")}
              description={t("cloud.authIntroDetail")}
            />
            <Space wrap>
              <Button
                type="primary"
                icon={<Cloud size={14} />}
                loading={busy}
                onClick={() => void startAuth()}
              >
                {t("cloud.authorize")}
              </Button>
              <Button loading={busy} onClick={() => void importFromTccli()}>
                {t("cloud.importTccli")}
              </Button>
            </Space>
            {authUrl ? (
              <>
                <Typography.Text type="secondary">
                  {t("cloud.authSteps")}
                </Typography.Text>
                <Space wrap>
                  <Button
                    icon={<ExternalLink size={14} />}
                    onClick={() =>
                      window.open(authUrl, "_blank", "noopener,noreferrer")
                    }
                  >
                    {t("cloud.reopen")}
                  </Button>
                  <Button
                    type="primary"
                    loading={busy}
                    onClick={() => void submitFromClipboard()}
                  >
                    {t("cloud.doneCopied")}
                  </Button>
                </Space>
                <Input.TextArea
                  rows={3}
                  value={code}
                  placeholder={t("cloud.pastePlaceholder")}
                  onChange={(event) => setCode(event.target.value)}
                />
                <Button loading={busy} onClick={() => void submitCode(code)}>
                  {t("cloud.submit")}
                </Button>
              </>
            ) : null}
          </Space>
        )}
      </Modal>
    </div>
  );
}
