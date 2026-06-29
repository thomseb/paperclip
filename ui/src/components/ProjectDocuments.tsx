import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { documentsApi, type DocumentEntry } from "../api/documents";
import { queryKeys } from "../lib/queryKeys";
import { FileText, Folder, FolderOpen, ChevronRight, ChevronDown, Loader2 } from "lucide-react";

/* ── Types ── */

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
  children: TreeNode[];
}

/* ── Helpers ── */

function buildTree(entries: DocumentEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  // First pass: create directory nodes
  for (const entry of entries) {
    if (entry.isDirectory) {
      const node: TreeNode = {
        name: entry.name,
        path: entry.path,
        isDirectory: true,
        size: 0,
        modified: "",
        children: [],
      };
      dirMap.set(entry.path, node);
    }
  }

  // Second pass: create file nodes and attach to parents
  for (const entry of entries) {
    const node: TreeNode = entry.isDirectory
      ? dirMap.get(entry.path)!
      : {
          name: entry.name,
          path: entry.path,
          isDirectory: false,
          size: entry.size,
          modified: entry.modified,
          children: [],
        };

    const parentPath = entry.path.includes("/")
      ? entry.path.substring(0, entry.path.lastIndexOf("/"))
      : "";

    if (parentPath && dirMap.has(parentPath)) {
      dirMap.get(parentPath)!.children.push(node);
    } else if (!parentPath) {
      root.push(node);
    }
  }

  return root;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── Simple Markdown Renderer ── */

function renderMarkdown(content: string): string {
  let html = content
    // Escape HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Headers
    .replace(/^#### (.+)$/gm, '<h4 class="text-sm font-semibold mt-4 mb-1">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold mt-5 mb-2">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-lg font-bold mt-6 mb-2">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold mt-6 mb-3">$1</h1>')
    // Bold and italic
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Code blocks
    .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre class="bg-muted rounded-lg p-3 my-3 text-xs overflow-x-auto"><code>$1</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="bg-muted px-1.5 py-0.5 rounded text-xs">$1</code>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr class="border-border my-4" />')
    // List items
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal">$1</li>')
    // Paragraphs (double newlines)
    .replace(/\n\n/g, '</p><p class="my-2">')
    // Single newlines within paragraphs
    .replace(/\n/g, "<br />");

  return `<p class="my-2">${html}</p>`;
}

/* ── Tree Item Component ── */

function TreeItem({
  node,
  selectedPath,
  onSelect,
  depth = 0,
}: {
  node: TreeNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isSelected = selectedPath === node.path;

  if (node.isDirectory) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 w-full px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded transition-colors"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          {expanded ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-amber-500" />
          )}
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {expanded && (
          <div>
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                selectedPath={selectedPath}
                onSelect={onSelect}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`flex items-center gap-1.5 w-full px-2 py-1 text-sm rounded transition-colors ${
        isSelected
          ? "bg-primary/10 text-primary font-medium"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
      }`}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <FileText className="h-4 w-4 shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

/* ── Main Component ── */

export function ProjectDocuments({ projectId }: { projectId: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const {
    data: listData,
    isLoading: listLoading,
    error: listError,
  } = useQuery({
    queryKey: ["project-documents", projectId],
    queryFn: () => documentsApi.list(projectId),
  });

  const {
    data: contentData,
    isLoading: contentLoading,
  } = useQuery({
    queryKey: ["project-document-content", projectId, selectedPath],
    queryFn: () =>
      selectedPath ? documentsApi.getContent(projectId, selectedPath) : null,
    enabled: !!selectedPath,
  });

  if (listLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading documents...
      </div>
    );
  }

  if (listError) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        Failed to load documents. Make sure the project has a workspace configured.
      </div>
    );
  }

  const documents = listData?.documents ?? [];
  const fileCount = documents.filter((d) => !d.isDirectory).length;
  const tree = buildTree(documents);

  if (fileCount === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
        <p className="text-sm">No documents found in the project workspace.</p>
        <p className="text-xs mt-1">
          Documents will appear here as agents create them during heartbeat runs.
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-0 border border-border rounded-xl overflow-hidden" style={{ height: "calc(100vh - 260px)" }}>
      {/* File tree sidebar */}
      <div className="w-72 shrink-0 border-r border-border bg-card overflow-y-auto">
        <div className="px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Documents ({fileCount})
          </span>
        </div>
        <div className="py-1">
          {tree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
            />
          ))}
        </div>
      </div>

      {/* Content viewer */}
      <div className="flex-1 overflow-y-auto bg-background">
        {!selectedPath && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Select a document to view
          </div>
        )}
        {selectedPath && contentLoading && (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading...
          </div>
        )}
        {selectedPath && contentData && (
          <div className="p-6">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-border">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  {selectedPath}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {formatSize(contentData.size)}
                  {contentData.modified && ` · ${formatDate(contentData.modified)}`}
                </span>
              </div>
            </div>
            <div
              className="prose prose-sm dark:prose-invert max-w-none text-foreground leading-relaxed"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(contentData.content),
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
