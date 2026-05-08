/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Earthling: per-tab exclusive lease table.
 *
 * Each tab is owned by at most one client. Ownership is asserted by
 * `claim()` (call sites: `Target.setAutoAttach` auto-lease, and explicit
 * `browser_switch_tab`). Released on explicit release, client disconnect,
 * or `force:true` take-over.
 */

import { daemonJsonl } from './debugJsonl';

export type Lease = {
  tabId: number;
  ownerClientId: string;
  claimedAt: number;
};

export type PendingClaim = {
  tabId: number;
  newOwner: string;
  oldOwner: string | null;
  expiresAt: number;
};

// Strictly greater than the extension's switchToTab ACK timeout (10s) so a
// slow-but-successful ACK cannot race the expiry sweep and land on an already-
// swept pending — commitPending would silently set a lease with no reservation.
const PENDING_EXPIRY_MS = 15_000;

export class LeaseTable {
  private _byTab = new Map<number, Lease>();
  // Pending claims are deliberately hidden from ownerOf/all readers — during
  // a two-phase force-switch the tab must appear busy (held by oldOwner) until
  // the commit lands, so a concurrent list_all_tabs never sees it as [free].
  private _pendingByTab = new Map<number, PendingClaim>();

  all(): Lease[] {
    return Array.from(this._byTab.values());
  }

  /** Pending-claim count exposed for snapshot instrumentation; readers must
   * still treat pendings as opaque (see `_pendingByTab` invariant). */
  pendingCount(): number {
    return this._pendingByTab.size;
  }

  ownerOf(tabId: number): Lease | undefined {
    return this._byTab.get(tabId);
  }

  /**
   * Reserve a pending claim on `tabId`. Does not mutate committed leases.
   * Sweeps every expired pending first so stranded entries cannot block peers.
   */
  reservePending(tabId: number, newOwner: string, oldOwner: string | null): PendingClaim {
    this.sweepExpiredPending();
    const existing = this._pendingByTab.get(tabId);
    if (existing)
      throw new Error(`Tab ${tabId} already has an in-flight switch reservation. Wait 1–2 seconds and retry, or call browser_list_all_tabs to re-sync.`);
    const pending: PendingClaim = { tabId, newOwner, oldOwner, expiresAt: Date.now() + PENDING_EXPIRY_MS };
    this._pendingByTab.set(tabId, pending);
    return pending;
  }

  commitPending(tabId: number): Lease | null {
    const pending = this._pendingByTab.get(tabId);
    if (!pending)
      return null;
    this._pendingByTab.delete(tabId);
    const lease: Lease = { tabId, ownerClientId: pending.newOwner, claimedAt: Date.now() };
    this._byTab.set(tabId, lease);
    return lease;
  }

  cancelPending(tabId: number): void {
    this._pendingByTab.delete(tabId);
  }

  hasPending(tabId: number): boolean {
    return this._pendingByTab.has(tabId);
  }

  /** Drop every pending claim owned by `clientId`. Called on client WS close. */
  cancelPendingFor(clientId: string): number[] {
    const cancelled: number[] = [];
    for (const [tabId, pending] of this._pendingByTab) {
      if (pending.newOwner === clientId) {
        this._pendingByTab.delete(tabId);
        cancelled.push(tabId);
      }
    }
    return cancelled;
  }

  /** Drop every pending claim past its expiresAt. Returns the cancelled tab ids. */
  sweepExpiredPending(): number[] {
    const now = Date.now();
    const cancelled: number[] = [];
    for (const [tabId, pending] of this._pendingByTab) {
      if (pending.expiresAt <= now) {
        this._pendingByTab.delete(tabId);
        cancelled.push(tabId);
      }
    }
    if (cancelled.length > 0)
      daemonJsonl('lease.pending.sweep.fired', { detail: { expired: cancelled, remaining: this._pendingByTab.size } });
    return cancelled;
  }

  /**
   * Try to claim `tabId` for `clientId`. Returns the current owner if the
   * tab is held by a different client and `force` is false.
   */
  claim(tabId: number, clientId: string, force: boolean): { ok: true; lease: Lease } | { ok: false; owner: Lease } {
    const existing = this._byTab.get(tabId);
    if (existing && existing.ownerClientId !== clientId && !force)
      return { ok: false, owner: existing };
    const lease: Lease = { tabId, ownerClientId: clientId, claimedAt: Date.now() };
    this._byTab.set(tabId, lease);
    return { ok: true, lease };
  }

  release(tabId: number, clientId: string): boolean {
    const existing = this._byTab.get(tabId);
    if (!existing || existing.ownerClientId !== clientId)
      return false;
    this._byTab.delete(tabId);
    return true;
  }

  /** Drop every lease. Called on extension loss — no tab is addressable. */
  clearAll(): number[] {
    const released = Array.from(this._byTab.keys());
    this._byTab.clear();
    return released;
  }

  releaseAllFor(clientId: string): number[] {
    const released: number[] = [];
    for (const [tabId, lease] of this._byTab) {
      if (lease.ownerClientId === clientId) {
        this._byTab.delete(tabId);
        released.push(tabId);
      }
    }
    return released;
  }

  /** Lowest-id tab not currently held. */
  firstFreeTab(candidateTabIds: number[]): number | undefined {
    const sorted = [...candidateTabIds].sort((a, b) => a - b);
    for (const id of sorted) {
      if (!this._byTab.has(id))
        return id;
    }
    return undefined;
  }
}
