export interface TurnQueueCallbacks {
  onPartial: (text: string) => void;
  onTurn: (text: string) => void;
  onSpeechDetected: () => void;
  onDrained: () => void;
}

export class TurnQueue {
  private pendingCommits = new Set<string>();
  private orderedItems: string[] = [];
  private committedItems = new Set<string>();
  private flushedItems = new Set<string>();
  private stable = new Map<string, string>();
  private intermediates = new Map<string, string>();
  private completions = new Map<string, string>();
  private nextCommitId = 0;

  constructor(private readonly callbacks: TurnQueueCallbacks) {}

  registerCommit(prefix = ''): string {
    const id = `${prefix}commit_${++this.nextCommitId}`;
    this.pendingCommits.add(id);
    return id;
  }

  hasPendingForPrefix(prefix: string): boolean {
    for (const id of this.pendingCommits) {
      if (id.startsWith(prefix)) return true;
    }
    for (const item of this.orderedItems) {
      if (item.startsWith(prefix)) return true;
    }
    return false;
  }

  isIdle(): boolean {
    return this.pendingCommits.size === 0 && this.orderedItems.length === 0;
  }

  private itemText(key: string): string {
    if (this.completions.has(key)) return this.completions.get(key) ?? '';
    return (this.stable.get(key) ?? '') + (this.intermediates.get(key) ?? '');
  }

  private checkUncommittedSpeech(): void {
    if (this.pendingCommits.size > 0) return;
    const keys = new Set([...this.stable.keys(), ...this.intermediates.keys()]);
    for (const key of keys) {
      if (!this.committedItems.has(key) && this.itemText(key).trim()) {
        this.callbacks.onSpeechDetected();
        break;
      }
    }
  }

  handleCommitted(key: string, commitPrefix = ''): void {
    if (this.committedItems.has(key)) return;
    for (const id of this.pendingCommits) {
      if (!commitPrefix || id.startsWith(commitPrefix)) {
        this.pendingCommits.delete(id);
        break;
      }
    }
    this.committedItems.add(key);
    this.orderedItems.push(key);
    this.checkUncommittedSpeech();
    this.flush(false);
    if (this.isIdle()) this.callbacks.onDrained();
  }

  handleDelta(key: string, delta: string): void {
    if (this.flushedItems.has(key)) return;
    this.stable.set(key, (this.stable.get(key) ?? '') + delta);
    const inter = this.intermediates.get(key);
    if (inter !== undefined) {
      this.intermediates.set(key, inter.startsWith(delta) ? inter.slice(delta.length) : '');
    }
    this.checkUncommittedSpeech();
    this.flush(false);
  }

  handleIntermediate(key: string, intermediate: string): void {
    if (this.flushedItems.has(key)) return;
    this.intermediates.set(key, intermediate);
    this.checkUncommittedSpeech();
    this.flush(false);
  }

  handleCompleted(key: string, transcript: string): void {
    if (this.flushedItems.has(key)) return;
    this.completions.set(key, transcript);
    this.flush(false);
    if (this.isIdle()) this.callbacks.onDrained();
  }

  handleFailed(key: string): void {
    if (this.flushedItems.has(key)) return;
    this.completions.set(key, this.itemText(key));
    this.flush(false);
    if (this.isIdle()) this.callbacks.onDrained();
  }

  handleCommitEmpty(commitId?: string): boolean {
    if (!commitId || !this.pendingCommits.delete(commitId)) return false;
    this.checkUncommittedSpeech();
    this.flush(false);
    if (this.isIdle()) this.callbacks.onDrained();
    return true;
  }

  dropPendingCommitsForPrefix(prefix: string): void {
    for (const id of [...this.pendingCommits]) {
      if (id.startsWith(prefix)) this.pendingCommits.delete(id);
    }
    if (this.isIdle()) this.callbacks.onDrained();
  }

  flush(remaining = false): void {
    while (this.orderedItems.length) {
      const key = this.orderedItems[0];
      if (!remaining && !this.completions.has(key)) break;
      this.orderedItems.shift();
      this.flushedItems.add(key);
      const text = this.itemText(key).trim();
      if (text) this.callbacks.onTurn(text);
      this.stable.delete(key);
      this.intermediates.delete(key);
      this.completions.delete(key);
    }
    if (remaining) {
      const unacknowledged = new Set([
        ...this.stable.keys(),
        ...this.intermediates.keys(),
        ...this.completions.keys(),
      ]);
      for (const key of unacknowledged) {
        const text = this.itemText(key).trim();
        if (text) this.callbacks.onTurn(text);
      }
      this.stable.clear();
      this.intermediates.clear();
      this.completions.clear();
      this.callbacks.onPartial('');
    } else {
      const keys = new Set([
        ...this.orderedItems,
        ...this.stable.keys(),
        ...this.intermediates.keys(),
        ...this.completions.keys(),
      ]);
      const combined = [...keys]
        .map(key => this.itemText(key).trim())
        .filter(Boolean)
        .join(' ');
      this.callbacks.onPartial(combined);
    }
  }
}
