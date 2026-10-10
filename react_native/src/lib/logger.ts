export type LogLevel = "log" | "info" | "warn" | "error" | "debug";
export type LogEntry = {
  id: number;
  timestamp: string;
  level: LogLevel;
  message: string;
};

// Keep the store and installation across Fast Refresh.
type LogStore = {
  entries: LogEntry[];
  listeners: Set<() => void>;
  nextId: number;
  installed: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
const loggerGlobal = globalThis as typeof globalThis & { __flashShareLogs?: LogStore };
const store = loggerGlobal.__flashShareLogs ??= {
  entries: [], listeners: new Set(), nextId: 1, installed: false,
};

function formatArgument(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    const ancestors: object[] = [];
    return JSON.stringify(value, function (key, item: unknown) {
      if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
      if (typeof item === "bigint") return `${item}n`;
      if (typeof item === "function" || typeof item === "symbol") return String(item);
      if (item !== null && typeof item === "object") {
        while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.includes(item)) return "[Circular]";
        if (ancestors.length >= 8) return "[Max depth]";
        ancestors.push(item);
      }
      return item;
    }, 2) ?? String(value);
  } catch {
    return "[Unserializable]";
  }
}

function notify() {
  if (store.timer !== undefined) return;
  store.timer = setTimeout(() => {
    store.timer = undefined;
    store.listeners.forEach((listener) => listener());
  }, 100);
}

export function installLogger() {
  if (store.installed) return;
  store.installed = true;
  const levels: LogLevel[] = ["log", "info", "warn", "error", "debug"];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      store.entries.push({
        id: store.nextId++, timestamp: new Date().toISOString(), level,
        message: args.map(formatArgument).join(" "),
      });
      notify();
    };
  }
}

export function getLogs(): LogEntry[] {
  return store.entries.slice();
}

export function subscribeLogs(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => { store.listeners.delete(listener); };
}

export function clearLogs() {
  store.entries = [];
  notify();
}
