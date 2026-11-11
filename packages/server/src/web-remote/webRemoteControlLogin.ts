import { createCredentialService, OAuthCredentialRepo } from "@zcode/services/node";
import type { WebRemoteControlLogin } from "./contract.js";

/**
 * Web 远程控制被控端的 JWT 来源（与 desktop 语义对齐：同账号登录态）。
 *
 * 优先从共享 credential store（~/.zcode/v2/credentials.json，经
 * services 的 OAuthCredentialRepo 解密读取，与 CLI/desktop 登录同一事实源）读取
 * 当前活跃账号的 access token 与用户 id；读不到时回退 env
 * ZCODE_WEB_REMOTE_CONTROL_JWT（env 注入无用户 id，用固定占位，JWT 是否被替换
 * 由 transport 的 401 → retryIfJwtReplaced 按 jwt 本身核对）。两者都缺 → undefined，
 * 上层按 auth-required 处理：不注册、不建连。
 */

export const WEB_REMOTE_CONTROL_JWT_ENV = "ZCODE_WEB_REMOTE_CONTROL_JWT";

/** env 回退登录没有账号 id；固定占位保证身份持久化键稳定（不随 JWT 刷新变化）。 */
export const WEB_REMOTE_CONTROL_ENV_LOGIN_USER_ID = "zcode-web-remote-control-env";

interface WebRemoteControlCredentialRepoLike {
  loadActiveTokenSet(): Promise<{ accessToken?: string } | null>;
  loadActiveUserProfile(): Promise<{ id?: string } | null>;
}

export interface WebRemoteControlServerLoginDependencies {
  env?: NodeJS.ProcessEnv;
  /** 单测注入；缺省用共享 credential store。 */
  credentialRepo?: WebRemoteControlCredentialRepoLike;
  logger: {
    warn: (...args: unknown[]) => void;
  };
}

export function createWebRemoteControlServerLogin(
  dependencies: WebRemoteControlServerLoginDependencies,
): {
  getLogin(): Promise<WebRemoteControlLogin | undefined>;
} {
  const env = dependencies.env ?? process.env;
  const repo =
    dependencies.credentialRepo ??
    new OAuthCredentialRepo(createCredentialService(), {});
  return {
    async getLogin() {
      const tokenSet = await repo.loadActiveTokenSet().catch((error: unknown) => {
        dependencies.logger.warn(
          "[web-remote-control:server] read credential store failed",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      });
      const accessToken = tokenSet?.accessToken?.trim();
      if (accessToken) {
        const profile = await repo.loadActiveUserProfile().catch(() => null);
        return { userId: profile?.id?.trim() || "credential-store", jwt: accessToken };
      }
      const envJwt = env[WEB_REMOTE_CONTROL_JWT_ENV]?.trim();
      if (envJwt) return { userId: WEB_REMOTE_CONTROL_ENV_LOGIN_USER_ID, jwt: envJwt };
      return undefined;
    },
  };
}
