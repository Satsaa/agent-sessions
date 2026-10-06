export interface CodexCredentials {
  auth_mode?: string;
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string };
  last_refresh?: string;
}

interface CodexAuthClaims {
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
  chatgpt_subscription_active_until?: string;
}

export interface CodexIdentity {
  accountId: string | undefined;
  email: string | undefined;
  plan: string | undefined;
  until: string | undefined;
}

/** Decode the ChatGPT id_token without verifying it: only the login owner reads this file, so the claims name the account. */
export function decodeCodexAuth(auth: CodexCredentials | undefined): CodexIdentity {
  const none: CodexIdentity = { accountId: auth?.tokens?.account_id, email: undefined, plan: undefined, until: undefined };
  const payload = auth?.tokens?.id_token?.split('.')[1];
  if (!payload) return none;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const openai = claims['https://api.openai.com/auth'] as CodexAuthClaims | undefined;
    return {
      accountId: openai?.chatgpt_account_id ?? none.accountId,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      plan: openai?.chatgpt_plan_type,
      until: openai?.chatgpt_subscription_active_until,
    };
  } catch {
    return none;
  }
}

