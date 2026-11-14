import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { monaco, cellUri } from "../monaco.ts";

export interface EditorKeys {
  onShiftEnter: () => void; // run & select next
  onCtrlEnter: () => void; // run in place
  onAltEnter: () => void; // run & insert below
  onEscape: () => void; // leave edit mode
  onFocus: () => void;
}

interface Props {
  id: string;
  language: "typescript" | "python" | "sql" | "markdown";
  value: string;
  onChange: (v: string) => void;
  focused: boolean;
  keys: EditorKeys;
  placeholder?: string;
  minLines?: number;
}

const LINE = 19;

export function CodeEditor({ id, language, value, onChange, focused, keys, placeholder, minLines = 1 }: Props) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const [height, setHeight] = useState(Math.max(minLines, value.split("\n").length) * LINE + 12);

  // When the cell changes type, its model URI changes; dispose the old model so
  // stale TypeScript declarations don't linger in the type checker.
  const uri = cellUri(id, language).toString();
  const prevUri = useRef(uri);
  useEffect(() => {
    if (prevUri.current === uri) return;
    const old = prevUri.current;
    prevUri.current = uri;
    setTimeout(() => monaco.editor.getModel(monaco.Uri.parse(old))?.dispose(), 0);
  }, [uri]);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor as unknown as monaco.editor.IStandaloneCodeEditor;
    const KM = monaco.KeyMod;
    const KC = monaco.KeyCode;
    // Command mode: once a key leaves edit mode (Esc, or Shift+Enter onto the next
    // cell), hand keyboard focus back to the page so A/B/D D/M/Y/... work at once,
    // as in Jupyter and VS Code. Checked after React has re-rendered. (Not done as
    // an effect on `focused`: clicking into an unselected cell briefly reports
    // focused=false and would lose the click's focus.)
    const leaveIfNotEditing = () =>
      setTimeout(() => {
        if (!focusedRef.current && editor.hasTextFocus()) (document.activeElement as HTMLElement | null)?.blur();
      }, 0);
    const bind = (keybinding: number, run: () => void, when?: string) =>
      editor.addCommand(keybinding, () => {
        run();
        leaveIfNotEditing();
      }, when);
    bind(KM.Shift | KC.Enter, () => keysRef.current.onShiftEnter());
    bind(KM.CtrlCmd | KC.Enter, () => keysRef.current.onCtrlEnter());
    bind(KM.Alt | KC.Enter, () => keysRef.current.onAltEnter());
    bind(KC.Escape, () => keysRef.current.onEscape(), "!suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible");
    editor.onDidFocusEditorText(() => keysRef.current.onFocus());
    const update = () => setHeight(Math.max(editor.getContentHeight(), minLines * LINE + 12));
    editor.onDidContentSizeChange(update);
    update();
    if (focused) editor.focus();
  };

  useEffect(() => {
    if (focused && editorRef.current && !editorRef.current.hasTextFocus()) editorRef.current.focus();
  }, [focused]);

  return (
    <div className="editor" style={{ height }}>
      {!value && placeholder && <div className="editor-placeholder">{placeholder}</div>}
      <Editor
        height={height}
        language={language}
        path={uri}
        keepCurrentModel
        value={value}
        onChange={(v) => onChange(v ?? "")}
        onMount={onMount}
        theme="vs-dark"
        options={{
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          scrollbar: { vertical: "hidden", horizontal: "auto", alwaysConsumeMouseWheel: false },
          lineNumbers: language === "markdown" ? "off" : "on",
          lineNumbersMinChars: 3,
          folding: false,
          glyphMargin: false,
          renderLineHighlight: focused ? "line" : "none",
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          wordWrap: language === "markdown" ? "on" : "off",
          fontSize: 13,
          lineHeight: LINE,
          padding: { top: 6, bottom: 6 },
          automaticLayout: true,
          fixedOverflowWidgets: true,
          tabSize: language === "python" ? 4 : 2,
          quickSuggestions: language !== "markdown",
        }}
      />
    </div>
  );
}
