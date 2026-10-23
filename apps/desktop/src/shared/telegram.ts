export interface TelegramAutonomySettingInput { enabled: boolean; expectedEnabled: boolean; expectedOwner: { userId: number; chatId: number; threadId: string } }

/** Status only. Bot credentials never cross renderer or resident IPC. */
export interface TelegramStatus {
  available: boolean;
  tokenConfigured: boolean;
  enabled: boolean;
  autonomyEnabled?: boolean;
  autonomyPaused?: boolean;
  connection: "disabled" | "connecting" | "online" | "failed";
  botUsername: string | null;
  owner: { userId: number; chatId: number; name: string; threadId: string } | null;
  pairing: { code: string; expiresAt: string; proposed: { userId: number; chatId: number; name: string } | null } | null;
  lastError: string | null;
  awaitingReview: number;
  failedDeliveries: number;
  unknownDeliveries: number;
  reviews: { key: string; runId: string | null; taskId: string | null }[];
  pendingDeliveries: number;
  capacity?: { inputs: number; inputLimit: number; deliveries: number; deliveryLimit: number; blocked: boolean };
  routes: { id: string; kind: "once" | "recurring"; fromRunAt: string }[];
  deliveries: { key: string; state: "pending" | "sending" | "submitted" | "failed" | "unknown"; preview: string; messageId: number | null; retryAllowed: boolean; error: string | null; reviewReport?: string }[];
}
export const telegramUnavailable = (): TelegramStatus => ({ available: false, tokenConfigured: false, enabled: false,
  connection: "disabled", botUsername: null, owner: null, pairing: null, lastError: "请先启用并连接常驻助手，再接入 Telegram。",
  awaitingReview: 0, failedDeliveries: 0, unknownDeliveries: 0, reviews: [], pendingDeliveries: 0, routes: [], deliveries: [] });
