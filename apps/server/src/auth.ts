/** Device tokens: mint, verify, revoke. Hashes live in the db, never the token. */
import {
  consumePairingCode, createPairingCode, findDeviceByToken, issueToken, listTokens, revokeToken,
  type Db, type Device, type IssuedToken,
} from "@getfit/db";

export interface PairRequest {
  code: string;
  deviceName: string;
  platform: "android" | "ios" | "cli";
  model?: string | null;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
    private readonly readOnly = false,
  ) {}

  /** Exchange a one-shot code (issued by the CLI) for a device token. */
  pair(request: PairRequest): IssuedToken | null {
    if (this.readOnly) return null;
    return consumePairingCode(
      this.db, request.code, request.deviceName, request.platform, request.model ?? null, this.clock(),
    );
  }

  verify(token: string): Device | null {
    if (!token) return null;
    return findDeviceByToken(this.db, token, this.clock(), !this.readOnly);
  }

  revoke(device: Device): boolean {
    if (this.readOnly) return false;
    return revokeToken(this.db, device.tokenId, this.clock());
  }

  issueForCli(name: string, platform = "cli", model: string | null = null): IssuedToken {
    return issueToken(this.db, { name, platform, model, now: this.clock() });
  }

  codeForCli(name: string, platform = "android", ttlSeconds = 300): { code: string; expiresAt: string } {
    return createPairingCode(this.db, { name, platform, ttlSeconds, now: this.clock() });
  }

  list(): ReturnType<typeof listTokens> {
    return listTokens(this.db);
  }
}
