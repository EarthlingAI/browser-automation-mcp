/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Earthling: TCP go-byte broadcaster for sub-ms cross-process release skew.
 *
 * Layer-B / Layer-C harnesses spawn worker processes that need to fire
 * release/switch ops at the same instant. setTimeout-based scheduling has
 * O(10ms) jitter; this gives <1ms by parking each worker on a blocking read
 * and broadcasting one byte to all peers when the barrier fills.
 *
 * Server: barrier(N) blocks until N clients connect, then writes one byte
 *   to each. Repeats indefinitely on subsequent rounds.
 * Client: connect(host, port).then(arm()) → resolves the next time the
 *   server broadcasts. Survives multiple rounds.
 *
 * Wire protocol: bare TCP, no framing. Each round = exactly one byte per
 * peer. The byte value carries no meaning; presence is the signal.
 */

import net from 'node:net';

export type SyncServer = {
	port: number;
	addr: string;
	/** Wait for `n` peers to all be parked, then broadcast. Resolves when sent. */
	barrier(n: number): Promise<void>;
	close(): void;
};

export type SyncClient = {
	/** Resolves when the server next broadcasts. Re-arm by calling again. */
	arm(): Promise<void>;
	close(): void;
};

export async function startSyncServer(): Promise<SyncServer> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(sock => {
		sock.setNoDelay(true);
		sockets.add(sock);
		sock.on('close', () => sockets.delete(sock));
		sock.on('error', () => sockets.delete(sock));
	});
	await new Promise<void>((resolve, reject) => {
		server.once('listening', () => resolve());
		server.once('error', reject);
		server.listen(0, '127.0.0.1');
	});
	const port = (server.address() as net.AddressInfo).port;

	return {
		port,
		addr: `127.0.0.1:${port}`,
		async barrier(n: number) {
			const deadline = Date.now() + 10_000;
			while (sockets.size < n) {
				if (Date.now() > deadline)
					throw new Error(`sync-broadcast: barrier(${n}) timed out (have ${sockets.size})`);
				await new Promise(r => setTimeout(r, 5));
			}
			const buf = Buffer.from([0x01]);
			for (const s of sockets)
				s.write(buf);
		},
		close() {
			for (const s of sockets) s.destroy();
			server.close();
		},
	};
}

export async function connectSyncClient(host: string, port: number): Promise<SyncClient> {
	const sock = await new Promise<net.Socket>((resolve, reject) => {
		const s = net.createConnection({ host, port }, () => resolve(s));
		s.setNoDelay(true);
		s.once('error', reject);
	});
	let pending: ((v: void) => void) | null = null;
	const buffered: Buffer[] = [];
	sock.on('data', (chunk: Buffer) => {
		if (pending) {
			const cb = pending; pending = null; cb();
		} else {
			buffered.push(chunk);
		}
	});
	return {
		arm() {
			return new Promise<void>(resolve => {
				if (buffered.length > 0) {
					buffered.shift();
					resolve();
				} else {
					pending = resolve;
				}
			});
		},
		close() { sock.destroy(); },
	};
}
