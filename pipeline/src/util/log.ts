const t0 = Date.now();

export function log(msg: string): void {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  process.stderr.write(`[${s}s] ${msg}\n`);
}
