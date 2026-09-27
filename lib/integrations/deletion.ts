interface Store {
  listConnectionAccounts(sessionId: string): Promise<string[]>;
  deleteSession(sessionId: string): Promise<void>;
}
interface Client { deleteAccount(accountId: string): Promise<void> }

export async function deletePersonaSession(store: Store, client: Client, sessionId: string): Promise<void> {
  for (const accountId of await store.listConnectionAccounts(sessionId)) await client.deleteAccount(accountId);
  await store.deleteSession(sessionId);
}
