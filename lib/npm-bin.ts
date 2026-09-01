/**
 * systemd/精简 PATH 经常没有 npm。优先当前 Node 旁边的二进制，并把该目录 prepend 进 PATH。
 */

import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

export function resolveNpmBin(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): string {
  const fromEnv = env.npm_execpath?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const sibling = join(dirname(execPath), NPM_BIN);
  if (existsSync(sibling)) return sibling;
  return NPM_BIN;
}

export function envWithNpmPath(
  env: NodeJS.ProcessEnv = process.env,
  npmBin: string = resolveNpmBin(env),
  execPath: string = process.execPath,
): NodeJS.ProcessEnv {
  const pathPrefix = dirname(npmBin === NPM_BIN ? execPath : npmBin);
  return {
    ...env,
    PATH: `${pathPrefix}${delimiter}${env.PATH ?? ""}`,
  };
}
