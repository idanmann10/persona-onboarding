import { createStore } from '../db/store';
import { getDatabase } from '../db/client';
import { createComposioClient } from '../integrations/composio';
import { createConnectionsService } from '../integrations/connections';
import { createConnectionHandlers } from './connections';

export function connectionHandlers() {
  const appBaseUrl = process.env.APP_BASE_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000');
  if (!appBaseUrl) throw new Error('APP_BASE_URL is required');
  const store = createStore(getDatabase());
  const client = createComposioClient(process.env.COMPOSIO_API_KEY || '');
  const service = createConnectionsService(store, client, {
    calendar: process.env.COMPOSIO_CALENDAR_AUTH_CONFIG_ID,
    gmail: process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID,
  }, appBaseUrl);
  return createConnectionHandlers(store, service, appBaseUrl);
}
