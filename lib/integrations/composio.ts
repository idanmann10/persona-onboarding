const ROOT = 'https://backend.composio.dev/api/v3.1';

type ToolSlug = 'GOOGLECALENDAR_EVENTS_LIST' | 'GMAIL_FETCH_EMAILS';

export function createComposioClient(key: string, fetchFn: typeof fetch = fetch) {
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetchFn(`${ROOT}${path}`, {
      ...init,
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Composio request failed (${response.status})`);
    return response.json() as Promise<Record<string, unknown>>;
  }
  return {
    createLink: async (userId: string, authConfigId: string, callbackUrl: string) => {
      const data = await request('/connected_accounts/link', {
        method: 'POST',
        body: JSON.stringify({ auth_config_id: authConfigId, user_id: userId, callback_url: callbackUrl }),
      });
      const redirectUrl = String(data.redirect_url || '');
      const url = new URL(redirectUrl);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.composio.dev')) throw new Error('Invalid Composio redirect');
      if (typeof data.connected_account_id !== 'string' || !data.connected_account_id) throw new Error('Missing connected account ID');
      return { accountId: data.connected_account_id, redirectUrl, expiresAt: typeof data.expires_at === 'string' ? data.expires_at : undefined };
    },
    getAccount: async (accountId: string) => request(`/connected_accounts/${encodeURIComponent(accountId)}`),
    deleteAccount: async (accountId: string) => {
      const response = await fetchFn(`${ROOT}/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`, {
        method: 'DELETE', headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) return;
      if (!response.ok) throw new Error(`Composio deletion failed (${response.status})`);
      const result = await response.json() as Record<string, unknown>;
      if (result.success !== true) throw new Error('Composio account deletion failed');
    },
    executeRead: async (slug: ToolSlug, accountId: string, userId: string, args: Record<string, unknown>) => {
      const result = await request(`/tools/execute/${slug}`, {
        method: 'POST',
        body: JSON.stringify({ connected_account_id: accountId, user_id: userId, version: 'latest', arguments: args }),
      });
      if (result.successful !== true) throw new Error(typeof result.error === 'string' ? result.error : 'Composio tool failed');
      return result.data;
    },
  };
}
