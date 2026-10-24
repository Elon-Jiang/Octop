import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { Button, Dropdown, Input, Select, Spin, Typography } from "antd";
import { History, Plus, Send, Square, X } from "lucide-react";

import {
  extractAskQuestions,
  isAskHitl,
  type HitlActionRequest,
} from "../../../../api/types/hitl";
import LazyMarkdown from "../../../../components/Markdown/LazyMarkdown";
import { useAgent } from "../../../../context/AgentContext";
import { useAgentThreadChat } from "../../../../hooks/useAgentThreadChat";
import { findCvmOpsAgent } from "../../../../hooks/useCvmOpsExpert";
import AskQuestionCard from "../../../Chat/components/AskQuestionCard";
import HitlApprovalCard from "../../../Chat/components/HitlApprovalCard";
import styles from "./CloudAiPanel.module.less";

/** 对话里出现的工具审批 / 提问消息片段。 */
type HitlSlice = {
  action_requests?: HitlActionRequest[];
  status?: "pending" | "approved" | "rejected";
  pending_id?: string;
};

export type InstanceBrief = {
  name: string;
  instance_id: string;
  region: string;
  zone: string;
  state: string;
  os_name: string;
  cpu: number;
  memory_gb: number;
  public_ips: string[];
  private_ips: string[];
};

/**
 * 云服务器会话的标题是首条消息全文（形如 `[当前云服务器] | 名称: xxx | 实例ID: ...`），
 * 直接放进历史下拉会挤成一行乱码。这里只取实例名。
 */
function threadLabel(thread: { title?: string | null }): string {
  const raw = (thread.title || "").trim();
  if (!raw) return "未命名对话";
  const named = raw.match(/名称[:：]\s*([^|]+)/);
  if (named?.[1]) {
    const name = named[1].trim();
    return name.length > 26 ? `${name.slice(0, 26)}…` : name;
  }
  return raw.length > 30 ? `${raw.slice(0, 30)}…` : raw;
}

function textOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

export default function CloudAiPanel({
  instance,
  onClose,
  preferredAgentId = null,
  expertEnsuring = false,
  expertError = null,
}: {
  instance: InstanceBrief | null;
  onClose: () => void;
  /** 页面级已就绪的运维专家 id（由 useCvmOpsExpert 提供）。 */
  preferredAgentId?: string | null;
  /** 页面级正在创建专家，用于面板占位提示。 */
  expertEnsuring?: boolean;
  /** 专家初始化失败原因，展示在面板顶部。 */
  expertError?: string | null;
}) {
  const { agents, activeAgent } = useAgent();
  const [agentId, setAgentId] = useState<string | null>(
    () =>
      preferredAgentId ??
      findCvmOpsAgent(agents)?.agent_id ??
      activeAgent?.agent_id ??
      agents[0]?.agent_id ??
      null,
  );
  const {
    messages,
    isStreaming,
    send,
    cancelStream,
    booting,
    threads,
    startNewThread,
    selectThread,
    resolveHitl,
  } = useAgentThreadChat(agentId, { hitlMode: "ask" });

  // 页面级专家创建是异步的，就绪后同步进面板
  useEffect(() => {
    if (preferredAgentId) setAgentId(preferredAgentId);
  }, [preferredAgentId]);
  const [draft, setDraft] = useState("");
  // 有挂起的审批 / 提问时先让用户处理卡片，避免新消息把这轮暂停冲掉
  const pendingPause = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const hitl = (messages[i] as { hitlData?: HitlSlice }).hitlData;
      if (hitl && (hitl.status ?? "pending") === "pending") return true;
    }
    return false;
  }, [messages]);
  // 历史下拉只列出真正有消息的会话：空壳会话点进去就是一片空白
  const historyThreads = useMemo(
    () => threads.filter((thread) => thread.has_messages !== false),
    [threads],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const sizeRef = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const MIN_W = 320;
  const MIN_H = 320;
  const MAX_W = 760;
  const MAX_H = 900;

  const clampPos = (x: number, y: number) => {
    const width = panelRef.current?.offsetWidth ?? 400;
    const height = panelRef.current?.offsetHeight ?? 600;
    return {
      x: Math.min(Math.max(8, x), window.innerWidth - width - 8),
      y: Math.min(Math.max(8, y), window.innerHeight - height - 8),
    };
  };

  const onHeaderPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (
        (event.target as HTMLElement).closest(
          "button, input, .octop-select, [role='combobox']",
        )
      ) {
        return;
      }
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        origX: rect.left,
        origY: rect.top,
      };
      setPos({ x: rect.left, y: rect.top });
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const onHeaderPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      setPos(
        clampPos(
          dragRef.current.origX + event.clientX - dragRef.current.startX,
          dragRef.current.origY + event.clientY - dragRef.current.startY,
        ),
      );
    },
    [],
  );

  const onHeaderPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onResizePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      sizeRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        origW: rect.width,
        origH: rect.height,
      };
      setSize({ w: rect.width, h: rect.height });
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const onResizePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!sizeRef.current) return;
      const top = pos?.y ?? 88;
      const maxW = Math.min(MAX_W, window.innerWidth - 48);
      const maxH = Math.min(MAX_H, window.innerHeight - top - 24);
      setSize({
        w: Math.min(
          Math.max(MIN_W, sizeRef.current.origW + event.clientX - sizeRef.current.startX),
          maxW,
        ),
        h: Math.min(
          Math.max(MIN_H, sizeRef.current.origH + event.clientY - sizeRef.current.startY),
          maxH,
        ),
      });
    },
    [pos],
  );

  const onResizePointerUp = useCallback(() => {
    sizeRef.current = null;
  }, []);

  useEffect(() => {
    if (!agentId && agents.length) setAgentId(agents[0].agent_id);
  }, [agentId, agents]);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const contextLine = useMemo(() => {
    if (!instance) return "";
    return [
      "[当前云服务器]",
      `名称: ${instance.name}`,
      `实例ID: ${instance.instance_id}`,
      `地域: ${instance.region}/${instance.zone}`,
      `状态: ${instance.state}`,
      `规格: ${instance.cpu} 核 / ${instance.memory_gb} GB`,
      `系统: ${instance.os_name}`,
      `公网IP: ${instance.public_ips[0] ?? "-"}`,
    ].join(" | ");
  }, [instance]);

  const submit = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    send(contextLine ? `${contextLine}\n\n${text}` : text);
    setDraft("");
  };

  return (
    <div
      ref={panelRef}
      className={`${styles.panel} ${pos ? styles.panelMoved : ""}`}
      style={{
        ...(pos ? { left: pos.x, top: pos.y } : {}),
        ...(size ? { width: size.w, height: size.h } : {}),
      }}
    >
      <div
        className={styles.header}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <Typography.Text strong>腾讯云运维专家</Typography.Text>
        <span className={styles.headerActions}>
          <Select
            size="small"
            variant="borderless"
            style={{ minWidth: 120 }}
            value={agentId ?? undefined}
            placeholder={expertEnsuring ? "正在准备专家…" : "选择专家"}
            disabled={expertEnsuring}
            options={agents.map((agent) => ({
              value: agent.agent_id,
              label: agent.name,
            }))}
            onChange={(value) => setAgentId(value)}
          />
          <Button
            size="small"
            type="text"
            title="新建对话"
            aria-label="新建对话"
            icon={<Plus size={14} />}
            disabled={!agentId || booting}
            onClick={() => void startNewThread()}
          />
          <Dropdown
            trigger={["click"]}
            menu={{
              items: historyThreads.length
                ? historyThreads.slice(0, 20).map((thread) => ({
                    key: thread.thread_id,
                    label: threadLabel(thread),
                  }))
                : [{ key: "__empty", label: "暂无历史对话", disabled: true }],
              onClick: ({ key }) => {
                if (key !== "__empty") void selectThread(key);
              },
            }}
          >
            <Button
              size="small"
              type="text"
              title="历史对话"
              aria-label="历史对话"
              icon={<History size={14} />}
              disabled={!agentId}
            />
          </Dropdown>
          <Button
            size="small"
            type="text"
            icon={<X size={14} />}
            onClick={onClose}
          />
        </span>
      </div>

      {expertError ? (
        <div className={styles.expertError} role="alert">
          <span className={styles.expertErrorTitle}>运维专家未就绪</span>
          <span className={styles.expertErrorBody}>{expertError}</span>
        </div>
      ) : null}

      <div className={styles.context}>
        {instance ? (
          <>
            <div className={styles.contextTitle}>已关联当前实例</div>
            <div className={styles.contextBody}>
              {instance.name} · {instance.instance_id}
              <br />
              {instance.region} / {instance.zone} · {instance.state}
            </div>
          </>
        ) : (
          <div className={styles.contextBody}>
            在左侧选择一台实例，提问时会自动带上它的信息。
          </div>
        )}
      </div>

      <div className={styles.list} ref={listRef}>
        {booting ? (
          <div className={styles.booting}>
            <Spin size="small" />
          </div>
        ) : messages.length ? (
          messages.map((message, index) => {
            const row = message as {
              role?: string;
              hitlData?: HitlSlice;
            };
            const role = row.role ?? "assistant";
            const text = textOf(message);

            // 工具执行前的审批 / 待回答的提问，直接渲染成卡片而不是文本
            if (row.hitlData) {
              const actions = row.hitlData.action_requests ?? [];
              const hitlStatus = row.hitlData.status ?? "pending";

              if (isAskHitl(actions)) {
                const questions = extractAskQuestions(actions);
                const pendingId = row.hitlData.pending_id;
                // pending 时渲染成可交互的选项卡（选项 / 确认并提交 / 关闭），
                // 提交后走 respond 决策让专家继续，不再把卡片藏起来。
                const canAnswer =
                  hitlStatus === "pending" && Boolean(pendingId);
                return (
                  <div
                    key={`hitl-${index}`}
                    className={styles.aiMsg}
                  >
                    <AskQuestionCard
                      questions={questions}
                      status={hitlStatus}
                      onSubmit={
                        canAnswer
                          ? (answer) =>
                              resolveHitl(
                                [{ type: "respond", message: answer }],
                                pendingId,
                              )
                          : undefined
                      }
                      onDismiss={
                        canAnswer
                          ? () =>
                              resolveHitl(
                                [
                                  {
                                    type: "respond",
                                    message:
                                      "用户关闭了提问，请按已有信息继续，不要再追问。",
                                  },
                                ],
                                pendingId,
                              )
                          : undefined
                      }
                    />
                  </div>
                );
              }

              return (
                <div key={`hitl-${index}`} className={styles.aiMsg}>
                  <HitlApprovalCard
                    actions={actions}
                    status={hitlStatus}
                    pendingId={row.hitlData.pending_id}
                    onDecision={(decisions, _policy, pendingId) =>
                      resolveHitl(decisions, pendingId)
                    }
                  />
                </div>
              );
            }

            if (!text) return null;
            if (role === "user") {
              return (
                <div key={`${role}-${index}`} className={styles.userMsg}>
                  {text}
                </div>
              );
            }
            return (
              <div key={`${role}-${index}`} className={styles.aiMsg}>
                <LazyMarkdown
                  content={text}
                  isStreaming={
                    isStreaming && index === messages.length - 1
                  }
                />
              </div>
            );
          })
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            可以问我：这台机器负载是否正常？最近有没有异常？要不要重启？
          </Typography.Text>
        )}
      </div>

      <div className={styles.composer}>
        <Input.TextArea
          autoSize={{ minRows: 2, maxRows: 5 }}
          value={draft}
          disabled={pendingPause}
          placeholder={
            pendingPause
              ? "请先处理上面的提问或审批，再继续对话"
              : instance
                ? `询问关于 ${instance.name} 的问题…`
                : "询问云服务器相关问题…"
          }
          onChange={(event) => setDraft(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className={styles.composerActions}>
          <span className={styles.hint}>
            {pendingPause ? "等待你在上方做出选择 · " : ""}Enter 发送 /
            Shift+Enter 换行
          </span>
          {isStreaming ? (
            <Button
              size="small"
              danger
              icon={<Square size={13} />}
              onClick={() => cancelStream()}
            >
              停止
            </Button>
          ) : (
            <Button
              size="small"
              type="primary"
              icon={<Send size={13} />}
              disabled={pendingPause || !draft.trim() || !agentId}
              onClick={submit}
            >
              发送
            </Button>
          )}
        </div>
      </div>
      <div
        className={styles.resizer}
        role="presentation"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
      />
    </div>
  );
}
