import * as vscode from 'vscode';

export interface RepositoryState {
    HEAD?: { commit?: string };
    onDidChange: vscode.Event<void>;
}

export interface Repository {
    rootUri: vscode.Uri;
    state: RepositoryState;
}

export interface GitAPI {
    repositories: Repository[];
    getRepository(uri: vscode.Uri): Repository | null;
}

export interface GitExtension {
    getAPI(version: number): GitAPI;
}
