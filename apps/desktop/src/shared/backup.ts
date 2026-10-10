export interface BackupResult { path: string; files: number; threads: number }
export interface RestoreResult extends BackupResult { transcriptDirectory: string; originWorkspace: string }
export interface RestorePreview { id: string; originWorkspace: string; createdAt: string; threads: number; files: number; stores: string[] }
