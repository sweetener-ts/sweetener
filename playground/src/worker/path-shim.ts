function normalizeParts(parts: string[]): string[] {
  const output: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop();
    else output.push(part);
  }
  return output;
}

export function resolve(...parts: string[]): string {
  const joined = parts.filter(Boolean).join("/");
  return `/${normalizeParts(joined.split("/")).join("/")}`;
}

export function normalize(fileName: string): string {
  return resolve(fileName);
}

export function join(...parts: string[]): string {
  return resolve(...parts);
}

export function dirname(fileName: string): string {
  const value = resolve(fileName);
  const index = value.lastIndexOf("/");
  return index <= 0 ? "/" : value.slice(0, index);
}

export function basename(fileName: string, suffix?: string): string {
  const value = resolve(fileName);
  const base = value.slice(value.lastIndexOf("/") + 1);
  return suffix !== undefined && suffix !== base && base.endsWith(suffix)
    ? base.slice(0, -suffix.length)
    : base;
}

export function isAbsolute(fileName: string): boolean {
  return fileName.startsWith("/");
}

export function relative(from: string, to: string): string {
  const left = normalizeParts(resolve(from).split("/"));
  const right = normalizeParts(resolve(to).split("/"));
  let shared = 0;
  while (left[shared] === right[shared] && shared < left.length) shared += 1;
  return (
    [...left.slice(shared).map(() => ".."), ...right.slice(shared)].join("/") ||
    "."
  );
}

export function parse(fileName: string): {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
} {
  const normalized = resolve(fileName);
  const dir = dirname(normalized);
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  return {
    root: "/",
    dir,
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base,
  };
}

export const posix = {
  resolve,
  normalize,
  join,
  dirname,
  basename,
  isAbsolute,
  relative,
  parse,
};
