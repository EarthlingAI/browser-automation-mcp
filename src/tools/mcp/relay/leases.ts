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

export type Lease = {
  tabId: number;
  ownerClientId: string;
  claimedAt: number;
};

export class LeaseTable {
  private _byTab = new Map<number, Lease>();

  all(): Lease[] {
    return Array.from(this._byTab.values());
  }

  ownerOf(tabId: number): Lease | undefined {
    return this._byTab.get(tabId);
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
