/** launchd registration is not proof that an authenticated runtime connection is ready. */
export interface ResidentServiceState {
  ok: boolean;
  registered: boolean;
  running: boolean;
  compatible: boolean;
  label: string;
  message?: string;
}
