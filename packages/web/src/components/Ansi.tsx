// Minimal ANSI SGR (colour/bold) renderer for kernel output. Deno and Python
// tracebacks both colour their output with escape codes.

import type { ReactNode } from "react";

const COLORS = ["#6e7681", "#f47067", "#57ab5a", "#e3b341", "#6aa9ff", "#dcbdfb", "#56d4dd", "#d7dae0"];
const BRIGHT = ["#8b949e", "#ff938a", "#6bc46d", "#f0c95b", "#8ec2ff", "#e6cdfd", "#76e3ea", "#ffffff"];

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

export function Ansi({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let color: string | undefined;
  let bold = false;
  let last = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let m: RegExpExecArray | null;
  const push = (s: string) => {
    if (!s) return;
    parts.push(
      color || bold ? (
        <span key={parts.length} style={{ color, fontWeight: bold ? 600 : undefined }}>
          {s}
        </span>
      ) : (
        s
      ),
    );
  };
  while ((m = re.exec(text))) {
    push(stripAnsi(text.slice(last, m.index)));
    last = re.lastIndex;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        color = undefined;
        bold = false;
      } else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c >= 30 && c <= 37) color = COLORS[c - 30];
      else if (c >= 90 && c <= 97) color = BRIGHT[c - 90];
      else if (c === 39) color = undefined;
      else if (c === 38 && codes[i + 1] === 5) i += 2; // 256-colour: skip
      else if (c === 38 && codes[i + 1] === 2) i += 4; // truecolour: skip
    }
  }
  push(stripAnsi(text.slice(last)));
  return <>{parts}</>;
}
