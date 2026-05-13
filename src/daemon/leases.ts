import { Lease, TabId } from "../protocol";

export class TabLeaseManager {
  private leases = new Map<TabId, Lease>();

  get(tabId: TabId): Lease | undefined {
    return this.leases.get(tabId);
  }

  heldBy(sessionId: string): TabId[] {
    const out: TabId[] = [];
    for (const [tabId, lease] of this.leases) {
      if (lease.sessionId === sessionId) out.push(tabId);
    }
    return out;
  }

  claim(
    tabId: TabId,
    sessionId: string,
    agentLabel?: string,
    opts: { force?: boolean; reason?: string } = {},
  ): { ok: true; previous?: Lease } | { ok: false; held: Lease } {
    const existing = this.leases.get(tabId);
    if (existing && existing.sessionId !== sessionId && !opts.force) {
      return { ok: false, held: existing };
    }
    const previous =
      existing && existing.sessionId !== sessionId ? existing : undefined;
    this.leases.set(tabId, {
      tabId,
      sessionId,
      agentLabel,
      claimedAt: Date.now(),
      reason: opts.reason,
    });
    return { ok: true, previous };
  }

  release(tabId: TabId, sessionId: string): boolean {
    const lease = this.leases.get(tabId);
    if (!lease || lease.sessionId !== sessionId) return false;
    return this.leases.delete(tabId);
  }

  releaseAll(sessionId: string): TabId[] {
    const released: TabId[] = [];
    for (const [tabId, lease] of [...this.leases]) {
      if (lease.sessionId === sessionId) {
        this.leases.delete(tabId);
        released.push(tabId);
      }
    }
    return released;
  }

  requireHolder(tabId: TabId, sessionId: string): Lease | null {
    const lease = this.leases.get(tabId);
    if (!lease || lease.sessionId !== sessionId) return null;
    return lease;
  }

  all(): Lease[] {
    return [...this.leases.values()];
  }

  dropTab(tabId: TabId): Lease | undefined {
    const lease = this.leases.get(tabId);
    this.leases.delete(tabId);
    return lease;
  }
}
