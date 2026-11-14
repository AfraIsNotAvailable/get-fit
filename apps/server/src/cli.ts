#!/usr/bin/env node
/** Operator tasks: mint tokens, hand out pairing codes, revoke a lost phone.
 *
 *   getfit token create --name "Pixel 9" [--platform android]
 *   getfit pair-code --name "Pixel 9" [--ttl 300]
 *   getfit token list
 *   getfit token revoke <token-id>
 */
import { initFresh, migrate, openDatabase } from "@getfit/db";
import { AuthService } from "./auth.js";
import { loadConfig } from "./env.js";

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const [group, action, id] = argv;
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  migrate(db);
  initFresh(db, new Date());
  const auth = new AuthService(db);

  try {
    if (group === "token" && action === "create") {
      const name = arg(argv, "--name");
      if (!name) { console.error("--name is required"); return 2; }
      const issued = auth.issueForCli(name, arg(argv, "--platform") ?? "cli");
      console.log(issued.token);
      console.error(`device ${issued.deviceId} · expires ${issued.expiresAt}`);
      return 0;
    }
    if (group === "pair-code") {
      const name = arg(argv, "--name");
      if (!name) { console.error("--name is required"); return 2; }
      const ttl = Number(arg(argv, "--ttl") ?? 300);
      const { code, expiresAt } = auth.codeForCli(name, "android", ttl);
      console.log(code);
      console.error(`for "${name}", valid until ${expiresAt}`);
      return 0;
    }
    if (group === "token" && action === "list") {
      for (const t of auth.list()) {
        const state = t.revokedAt ? "revoked" : (t.lastUsedAt ? `used ${t.lastUsedAt}` : "never used");
        console.log(`${t.tokenId}  ${t.name}  ${t.platform}  ${state}`);
      }
      return 0;
    }
    if (group === "token" && action === "revoke") {
      if (!id) { console.error("token id is required"); return 2; }
      const ok = auth.revoke({ tokenId: id } as never);
      console.log(ok ? `revoked ${id}` : `no live token ${id}`);
      return ok ? 0 : 1;
    }
    console.error("usage: token create|list|revoke | pair-code");
    return 2;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  process.exit(main(process.argv.slice(2)));
}
