/** Host verified transport account, separate from a sender or execution identity. */
export type ChannelAccount =
  | { platform: "telegram"; id: string; name: string; tokenEnv: string; proxyEnv?: string }
  | { platform: "qq"; id: string; name: string; configPath: string };
export interface ChannelConversation {
  platform: "telegram" | "qq";
  accountId: string;
  kind: "private" | "topic" | "group";
  externalId: string;
  topicId?: number;
}
export interface ChannelTarget { accountId?: string; topicId?: number }
export interface ChannelAccountStatus {
  platform: "telegram" | "qq";
  id: string;
  name: string;
  botId: number | null;
  connection: "disabled" | "connecting" | "online" | "failed" | "unverified";
  message?: string;
  conversations: (ChannelConversation & { workspace: string; threadId: string; revision: number; readOnly?: boolean })[];
}
