export interface BackupResult { path: string; files: number; threads: number }
export interface RestoreResult extends BackupResult { transcriptDirectory: string; originWorkspace: string }
