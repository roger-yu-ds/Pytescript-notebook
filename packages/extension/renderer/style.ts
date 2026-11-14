// Answer styles: VS Code theme variables, plus highlight.js colours for dark and light themes.
export const STYLE = `
.pt-answer { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); line-height: 1.55; color: var(--vscode-foreground); padding: 2px 0 4px; }
.pt-answer p { margin: 0.45em 0; }
.pt-answer ul, .pt-answer ol { margin: 0.4em 0; padding-left: 1.4em; }
.pt-answer code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; background: var(--vscode-textCodeBlock-background); padding: 0.05em 0.3em; border-radius: 3px; }
.pt-answer a { color: var(--vscode-textLink-foreground); }
.pt-code { margin: 0.6em 0; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); border-radius: 5px; overflow: hidden; }
.pt-code-bar { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 2px 10px; background: var(--vscode-editorGroupHeader-tabsBackground, rgba(128,128,128,.1)); font-size: 11px; color: var(--vscode-descriptionForeground); }
.pt-actions { display: flex; gap: 4px; }
.pt-btn { font: inherit; font-size: 11px; cursor: pointer; border: 1px solid transparent; border-radius: 3px; padding: 1px 7px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
.pt-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.pt-code pre { margin: 0; padding: 8px 10px; overflow-x: auto; background: var(--vscode-textCodeBlock-background); }
.pt-code pre code { background: none; padding: 0; font-size: var(--vscode-editor-font-size, 13px); }
.pt-thinking { margin: 0 0 0.5em; color: var(--vscode-descriptionForeground); font-size: 0.95em; }
.pt-thinking summary { cursor: pointer; user-select: none; }
.pt-waiting { color: var(--vscode-descriptionForeground); font-style: italic; }
.pt-caret { display: inline-block; width: 7px; height: 1em; vertical-align: text-bottom; background: var(--vscode-editorCursor-foreground, currentColor); animation: pt-blink 1s steps(2) infinite; }
@keyframes pt-blink { 50% { opacity: 0; } }
.pt-error { color: var(--vscode-errorForeground); margin-top: 0.4em; }
.hljs-keyword, .hljs-built_in, .hljs-literal { color: #569cd6; }
.hljs-string, .hljs-regexp { color: #ce9178; }
.hljs-number { color: #b5cea8; }
.hljs-comment { color: #6a9955; font-style: italic; }
.hljs-title, .hljs-title.function_ { color: #dcdcaa; }
.hljs-type, .hljs-title.class_ { color: #4ec9b0; }
.hljs-attr, .hljs-variable, .hljs-params { color: #9cdcfe; }
body.vscode-light .hljs-keyword, body.vscode-light .hljs-built_in, body.vscode-light .hljs-literal { color: #0000ff; }
body.vscode-light .hljs-string, body.vscode-light .hljs-regexp { color: #a31515; }
body.vscode-light .hljs-number { color: #098658; }
body.vscode-light .hljs-comment { color: #008000; }
body.vscode-light .hljs-title, body.vscode-light .hljs-title.function_ { color: #795e26; }
body.vscode-light .hljs-type, body.vscode-light .hljs-title.class_ { color: #267f99; }
body.vscode-light .hljs-attr, body.vscode-light .hljs-variable, body.vscode-light .hljs-params { color: #001080; }
`;
