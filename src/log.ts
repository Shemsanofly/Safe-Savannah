/** Minimal structured logger (JSON lines) shared by the workers. */
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

export function logger(component: string) {
  const emit = (level: Level, msg: string, extra?: Record<string, unknown>) => {
    if (order[level] < threshold) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, component, msg, ...extra });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
  };
}
export type Logger = ReturnType<typeof logger>;

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
