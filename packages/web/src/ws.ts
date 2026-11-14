// One shared WebSocket to the backend, with automatic reconnect.
import type { ClientMsg, ServerMsg } from "@polyglot-tutor/core/browser";

type Listener = (msg: ServerMsg) => void;
const listeners = new Set<Listener>();
const statusListeners = new Set<(up: boolean) => void>();
let socket: WebSocket | null = null;
let queue: string[] = [];

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => {
    for (const m of queue) ws.send(m);
    queue = [];
    statusListeners.forEach((l) => l(true));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data) as ServerMsg;
    listeners.forEach((l) => l(msg));
  };
  ws.onclose = () => {
    statusListeners.forEach((l) => l(false));
    setTimeout(connect, 1000);
  };
}
connect();

export function send(msg: ClientMsg) {
  const s = JSON.stringify(msg);
  if (socket?.readyState === WebSocket.OPEN) socket.send(s);
  else queue.push(s);
}

export function subscribe(l: Listener) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export function onConnection(l: (up: boolean) => void) {
  statusListeners.add(l);
  return () => void statusListeners.delete(l);
}
