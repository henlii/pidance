"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { ProjectAssetsEditor } from "../ProjectAssetsEditor";
import { ViewportDialog } from "../ui/ViewportDialog";

export interface EditProjectDialogProps {
  projectRoot: string | null;
  initialName: string;
  onClose: () => void;
  onSaveName: (name: string) => void;
}

/** 编辑项目：显示名 alias + 项目规则/技能。不改 Pi schema/目录/Git。 */
export function EditProjectDialog({ projectRoot, initialName, onClose, onSaveName }: EditProjectDialogProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"name" | "rules" | "skills">("name");
  const [value, setValue] = useState(initialName);

  useEffect(() => {
    if (projectRoot === null) return;
    setTab("name");
    setValue(initialName);
  }, [projectRoot, initialName]);

  return (
    <ViewportDialog
      open={projectRoot !== null}
      onClose={onClose}
      title={t("sidebar_editProject")}
      width={720}
      height={620}
      closeLabel={t("dialog_close")}
      description={projectRoot
        ? t("sidebar_editProjectDescription", { path: projectRoot })
        : undefined}
    >
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {([
          ["name", t("sidebar_projectName")],
          ["rules", t("sidebar_projectRules")],
          ["skills", t("sidebar_projectSkills")],
        ] as const).map(([tabId, label]) => (
          <button
            key={tabId}
            type="button"
            onClick={() => setTab(tabId)}
            style={{
              minHeight: 28, padding: "0 12px", borderRadius: 6,
              border: "1px solid var(--border)",
              background: tab === tabId ? "var(--bg-selected)" : "var(--bg-panel)",
              color: tab === tabId ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", fontSize: 12, fontWeight: tab === tabId ? 600 : 400,
            }}
            aria-current={tab === tabId ? "page" : undefined}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "name" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const name = value.trim();
            if (!name) return;
            onSaveName(name);
          }}
        >
          <label
            htmlFor="edit-project-name"
            style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}
          >
            {t("sidebar_projectName")}
          </label>
          <input
            id="edit-project-name"
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("sidebar_projectName")}
            aria-label={t("sidebar_projectName")}
            aria-invalid={!value.trim()}
            autoComplete="off"
            spellCheck={false}
            style={{
              width: "100%",
              height: 32,
              fontSize: 12.5,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              outline: "none",
              background: "var(--bg-panel)",
              color: "var(--text)",
              boxSizing: "border-box",
            }}
          />
          {!value.trim() && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--status-danger)" }}>{t("sidebar_projectNameRequired")}</div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button
              type="submit"
              disabled={!value.trim()}
              style={{
                minHeight: 30, padding: "0 14px", borderRadius: 7,
                border: "1px solid var(--accent)", background: "var(--accent)",
                color: "var(--accent-foreground)",
                cursor: !value.trim() ? "not-allowed" : "pointer",
                fontSize: 12, fontWeight: 600,
                opacity: !value.trim() ? 0.6 : 1,
              }}
            >
              {t("sidebar_save")}
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                minHeight: 30, padding: "0 12px", borderRadius: 7,
                border: "1px solid var(--border)", background: "var(--bg-panel)",
                color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
              }}
            >
              {t("sidebar_cancel")}
            </button>
          </div>
        </form>
      ) : (
        projectRoot && (
          <ProjectAssetsEditor
            cwd={projectRoot}
            tab={tab === "skills" ? "skills" : "rules"}
          />
        )
      )}
    </ViewportDialog>
  );
}
