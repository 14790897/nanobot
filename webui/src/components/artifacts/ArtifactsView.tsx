import { useMemo, useState, useEffect, useRef } from "react";
import { FileCode, FileImage, FileText, FileSpreadsheet, Paperclip, X, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useSessionHistory } from "@/hooks/useSessions";

interface ArtifactItem {
  id: string;
  type: "image" | "video" | "file" | "code" | "pdf" | "spreadsheet" | "text";
  title: string;
  subtitle?: string;
  url: string;
  messageId: string;
}

// 匹配消息内容中的工作区文件路径
const WORKSPACE_PATH_RE = /(?:[A-Za-z]:[\\/][^\s<>]+|[~\/][^\s<>]+|\.[\\/][^\s<>]+|[^\s<>]+\.[a-zA-Z0-9]{1,10})/g;

// 文本类文件扩展名
const TEXT_EXTS = new Set([
  "txt", "md", "mdx", "json", "yaml", "yml", "xml", "html", "htm",
  "css", "js", "ts", "tsx", "jsx", "py", "sh", "bash", "csv", "log",
  "ini", "conf", "toml", "cfg", "rst", "tex", "sql", "graphql", "gql",
  "c", "cpp", "h", "java", "go", "rs", "rb", "php", "swift", "kt",
]);

function extractWorkspaceFiles(content: string): string[] {
  if (!content) return [];
  const files: string[] = [];
  const matches = content.matchAll(WORKSPACE_PATH_RE);
  for (const match of matches) {
    const path = match[0];
    if (/^(https?:|ftp:|\/\/|import\s|require\(|from\s")/.test(path)) continue;
    files.push(path.replace(/\\/g, "/"));
  }
  return [...new Set(files)];
}

function pathToUrl(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  const m = normalized.match(/\.nanobot\/workspace\/(.+)$/);
  const relativePath = m ? m[1] : normalized.replace(/^\//, "");
  const token = localStorage.getItem("nb_api_token") || "";
  const encoded = relativePath.split("/").map(encodeURIComponent).join("/");

  // 始终用相对路径，让 Vite dev proxy或生产环境同一 origin 处理
  // 这样彻底避免 CORS 问题
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  return `/api/workspace/${encoded}${qs}`;
}

function getFileType(filename: string): ArtifactItem["type"] {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (["csv", "xlsx", "xls"].includes(ext)) return "spreadsheet";
  if (TEXT_EXTS.has(ext)) return "text";
  return "file";
}

// ---- ArtifactCard ----

interface ArtifactCardProps {
  artifact: ArtifactItem;
  onClick: () => void;
}

const ICON_MAP: Record<ArtifactItem["type"], React.ElementType> = {
  image: FileImage,
  video: Paperclip,
  file: FileText,
  pdf: FileText,
  spreadsheet: FileSpreadsheet,
  text: FileText,
  code: FileCode,
};

function ArtifactCard({ artifact, onClick }: ArtifactCardProps) {
  const Icon = ICON_MAP[artifact.type] || FileText;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm transition-all hover:shadow-md cursor-pointer"
    >
      <div className="flex h-36 items-center justify-center bg-muted/40">
        {artifact.type === "image" && (
          <>
            {!loaded && !error && (
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground/70" />
            )}
            <img
              src={artifact.url}
              alt={artifact.title}
              className={`h-full w-full object-cover ${loaded ? "" : "hidden"}`}
              onLoad={() => setLoaded(true)}
              onError={() => setError(true)}
            />
            {error && <Icon className="h-8 w-8 text-muted-foreground/50" />}
          </>
        )}
        {artifact.type === "text" && (
          <div className="flex flex-col items-center gap-1">
            <FileText className="h-8 w-8 text-blue-500/70" />
            <span className="text-[10px] text-muted-foreground">TEXT</span>
          </div>
        )}
        {artifact.type === "pdf" && (
          <div className="flex flex-col items-center gap-1">
            <FileText className="h-8 w-8 text-red-500/70" />
            <span className="text-[10px] text-muted-foreground">PDF</span>
          </div>
        )}
        {artifact.type === "spreadsheet" && (
          <div className="flex flex-col items-center gap-1">
            <FileSpreadsheet className="h-8 w-8 text-green-600/70" />
            <span className="text-[10px] text-muted-foreground">Spreadsheet</span>
          </div>
        )}
        {(artifact.type === "file" || artifact.type === "video") && (
          <Icon className="h-8 w-8 text-muted-foreground/50" />
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground/70" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground/90">{artifact.title}</p>
          {artifact.subtitle ? (
            <p className="truncate text-[11px] text-muted-foreground">{artifact.subtitle}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---- TextPreviewModal ----

function TextPreviewModal({
  artifact,
  onClose,
}: {
  artifact: ArtifactItem;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const contentRef = useRef<HTMLPreElement>(null);

  // 用 useEffect 加载文件内容，避免无限渲染
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    setContent(null);

    const url = artifact.url;

    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((e: Error) => {
        if (!cancelled) setFetchError(e.message || "加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [artifact.url]);

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // 点击遮罩关闭
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleOverlayClick}
    >
      <div className="flex max-h-[85vh] w-[92vw] max-w-4xl flex-col rounded-2xl bg-background shadow-2xl overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3 shrink-0">
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate text-sm font-semibold">{artifact.title}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-auto px-4 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载中...
            </div>
          ) : fetchError ? (
            <div className="flex items-center justify-center py-16 text-sm text-destructive">
              {fetchError}
            </div>
          ) : content !== null ? (
            <pre
              ref={contentRef}
              className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90 font-mono"
            ><code>{content}</code></pre>
          ) : (
            <div className="py-16 text-center text-sm text-muted-foreground">
              无法加载文件内容
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- ArtifactsView (main export) ----

export function ArtifactsView({
  activeKey,
  onBackToChat,
}: {
  activeKey: string | null;
  onBackToChat: () => void;
}) {
  const { t } = useTranslation();
  const { messages, loading } = useSessionHistory(activeKey);
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactItem | null>(null);

  const artifacts = useMemo(() => {
    const items: ArtifactItem[] = [];
    const seen = new Set<string>();

    for (const msg of messages) {
      if (msg.role !== "assistant") continue;

      const content = msg.content || "";
      const files = extractWorkspaceFiles(content);

      if (msg.media && msg.media.length > 0) {
        for (const media of msg.media) {
          if (media.url) {
            const filename = media.name || media.url.split("/").pop() || "file";
            const key = `media-${media.url}`;
            if (!seen.has(key)) {
              seen.add(key);
              items.push({
                id: key,
                type: media.kind || getFileType(filename),
                title: filename,
                url: media.url,
                messageId: msg.id,
              });
            }
          }
        }
      }

      for (const filePath of files) {
        const url = pathToUrl(filePath);
        const filename = filePath.split("/").pop() || filePath;
        const key = `workspace-${url}`;
        if (!seen.has(key)) {
          seen.add(key);
          items.push({
            id: key,
            type: getFileType(filename),
            title: filename,
            subtitle: filePath,
            url,
            messageId: msg.id,
          });
        }
      }
    }

    return items;
  }, [messages]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
        <button
          type="button"
          onClick={onBackToChat}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("artifacts.back")}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1 className="text-sm font-semibold">{t("artifacts.title")}</h1>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {artifacts.length}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            {t("thread.loadingConversation")}
          </div>
        ) : artifacts.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-center">
            <FileCode className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t("artifacts.empty")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {artifacts.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                onClick={() => {
                  if (artifact.type === "text") {
                    setPreviewArtifact(artifact);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Text preview modal */}
      {previewArtifact && (
        <TextPreviewModal
          artifact={previewArtifact}
          onClose={() => setPreviewArtifact(null)}
        />
      )}
    </div>
  );
}
