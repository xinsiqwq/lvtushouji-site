import type { SecurityPolicy } from '../shared/types';

export type AppBindings = Env & {
  ARENA_ROOM: DurableObjectNamespace;
  SESSION_SECRET: string;
  SETUP_TOKEN?: string;
  TIANDITU_KEY?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string;
  CF_ZONE_NAME?: string;
  CF_WORKER_NAME?: string;
  CF_D1_DATABASE_ID?: string;
  CF_R2_BUCKET_NAME?: string;
};

export type CloudContext = {
  configured: boolean;
  authenticated: boolean;
  sessionId: string | null;
  csrfToken: string | null;
  visitorId: string;
  address: string;
  policy: SecurityPolicy;
  cookies: string[];
};

export type AppVariables = {
  costEnv: AppBindings;
  cloudCtx: CloudContext;
};
