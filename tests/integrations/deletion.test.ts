import { describe, expect, it } from 'vitest';
import { deletePersonaSession } from '../../lib/integrations/deletion';

describe('session deletion', () => {
  it('removes provider connections before deleting local state', async () => {
    const order: string[] = [];
    await deletePersonaSession({
      listConnectionAccounts: async () => ['ca_one', 'ca_two'],
      deleteSession: async () => { order.push('local'); },
    }, { deleteAccount: async (id: string) => { order.push(id); } }, 'owner');
    expect(order).toEqual(['ca_one', 'ca_two', 'local']);
  });

  it('keeps local state when provider deletion fails so it can be retried', async () => {
    let localDeleted = false;
    await expect(deletePersonaSession({ listConnectionAccounts: async () => ['ca_one'], deleteSession: async () => { localDeleted = true; } },
      { deleteAccount: async () => { throw new Error('provider unavailable'); } }, 'owner')).rejects.toThrow();
    expect(localDeleted).toBe(false);
  });
});
