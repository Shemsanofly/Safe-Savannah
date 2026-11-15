/** Tiny "--key value" / "--flag" parser for the CLIs. Repeated keys collect into arrays. */
export function parseArgs(argv: string[] = process.argv.slice(2)): { flags: Map<string, string[]>; positional: string[] } {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else positional.push(a);
  }
  return { flags, positional };
}

export function flag(flags: Map<string, string[]>, key: string): string | undefined {
  return flags.get(key)?.at(-1);
}
