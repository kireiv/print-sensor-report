import { parsePackets } from './protocol.js';
import { NoReplyError, handshake } from './transport.js';
/**
 * The NIIMBOT GATT service. Discovery does NOT filter on it (see `connect`),
 * but it still has to be declared as an optional service or the browser
 * refuses to hand over the characteristics after a name match.
 */
const SERVICE = 'e7810a71-73ae-499d-8c15-faa9aef0c3f2';
/** Whether this browser exposes Web Bluetooth at all (Chromium only). */
export function hasBluetooth() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}
/** Web Bluetooth is unavailable on insecure origins, localhost excepted. */
export function isSecureContext() {
    return typeof window !== 'undefined' && window.isSecureContext;
}
/**
 * Both conditions the browser must meet. Check the two separately when you
 * want to tell the user WHICH one failed, since the fixes differ: a missing
 * API means the wrong browser, an insecure context means the wrong origin.
 */
export function isSupported() {
    return hasBluetooth() && isSecureContext();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Pick a printer.
 *
 * Discovery matches on device NAME, never on service UUID. This is not a
 * preference: a service-UUID filter makes Chrome push a `SetDiscoveryFilter`
 * UUID list to BlueZ, which segfaults `bluetoothd` 5.87 on desktop Linux and
 * takes the user's whole Bluetooth stack down with it. The service still has
 * to appear under `optionalServices` so its characteristics can be read once
 * the name match has granted the device.
 *
 * `getDevices()` is tried first so an already-permitted printer reconnects
 * with no chooser at all.
 */
async function pickDevice(namePrefix, services) {
    if (navigator.bluetooth.getDevices) {
        try {
            const known = await navigator.bluetooth.getDevices();
            const hit = known.find((d) => (d.name ?? '').startsWith(namePrefix));
            if (hit)
                return hit;
        }
        catch {
            // permissions backend unavailable — fall through to a chooser
        }
    }
    return navigator.bluetooth.requestDevice({
        filters: [{ namePrefix }],
        optionalServices: services
    });
}
/**
 * The printer's channel is one characteristic that both notifies and takes
 * writes without response. Which one that is varies by firmware, so it is
 * found by capability rather than by a hardcoded UUID.
 */
async function findChannel(server, services) {
    for (const uuid of services) {
        let service;
        try {
            service = await server.getPrimaryService(uuid);
        }
        catch {
            continue; // this printer does not expose that service
        }
        for (const c of await service.getCharacteristics()) {
            if (c.properties.notify && c.properties.writeWithoutResponse)
                return c;
        }
    }
    throw new Error('no notify + write characteristic found on the printer');
}
/**
 * Listener teardown for the last connect on a given device.
 *
 * Chrome hands back the same device and characteristic objects for the whole
 * page session, so a second connect would stack a second set of handlers on
 * them: `onDisconnect` would fire twice per drop, and two notification handlers
 * would each accumulate their own copy of the inbound stream. The previous
 * connect's listeners are removed before new ones go on.
 */
const wiring = new WeakMap();
/**
 * Connect to a NIIMBOT printer over Web Bluetooth.
 *
 * Must be called from a user gesture, per the Web Bluetooth spec. Returns once
 * the opening handshake has been answered, so the link is ready to print.
 *
 * The handshake is RETRIED, because a B1 routinely ignores the first one. GATT
 * connect and `startNotifications` both resolve before the printer's link is
 * really settled — connection parameters and MTU are still being negotiated —
 * so the opening `Connect` goes out into a link that swallows it. One attempt
 * therefore fails on a cold connection and succeeds on the next, which reads to
 * a user as "it never works the first time". Anything that fails here tears the
 * GATT link down on the way out rather than leaving it half-open.
 */
export async function connect(options = {}) {
    const { namePrefix = 'B1', services = [SERVICE], chunkSize = 20, paceMs = 8, handshakeAttempts = 3, settleMs = 250, onDisconnect } = options;
    const device = await pickDevice(namePrefix, services);
    if (!device.gatt)
        throw new Error('device has no GATT server');
    wiring.get(device)?.();
    const teardown = [];
    const unwire = () => {
        for (const off of teardown.splice(0))
            off();
    };
    wiring.set(device, unwire);
    const dropped = () => onDisconnect?.();
    device.addEventListener('gattserverdisconnected', dropped);
    teardown.push(() => device.removeEventListener('gattserverdisconnected', dropped));
    const server = await device.gatt.connect();
    const channel = await findChannel(server, services).catch((err) => {
        unwire();
        server.disconnect();
        throw err;
    });
    // Inbound bytes arrive in 20-byte notifications that respect no packet
    // boundary, so they are accumulated and drained through the parser; `rest`
    // carries a straddling packet's head across to the next notification.
    // annotated, not inferred: parsePackets returns a slice over ArrayBufferLike,
    // which the narrower inferred type would refuse
    let pending = new Uint8Array(0);
    let inbox = [];
    let wake = null;
    const notified = (e) => {
        const value = e.target.value;
        if (!value)
            return;
        // copied byte by byte rather than wrapping value.buffer: a DataView can
        // be a window onto a larger buffer, and wrapping it would read whatever
        // sits either side of the notification
        const merged = new Uint8Array(pending.length + value.byteLength);
        merged.set(pending);
        for (let i = 0; i < value.byteLength; i++)
            merged[pending.length + i] = value.getUint8(i);
        const { packets, rest } = parsePackets(merged);
        pending = rest;
        if (!packets.length)
            return;
        inbox.push(...packets);
        // a runaway buffer means nobody is reading; keep only recent traffic
        if (inbox.length > 64)
            inbox = inbox.slice(-64);
        wake?.();
    };
    channel.addEventListener('characteristicvaluechanged', notified);
    teardown.push(() => channel.removeEventListener('characteristicvaluechanged', notified));
    await channel.startNotifications();
    const link = {
        deviceName: device.name ?? 'printer',
        async send(bytes) {
            for (let o = 0; o < bytes.length; o += chunkSize) {
                await channel.writeValueWithoutResponse(bytes.slice(o, o + chunkSize));
                if (paceMs)
                    await sleep(paceMs);
            }
        },
        receive(cmds, timeoutMs) {
            // Anything already queued ahead of the match is stale by definition —
            // we are waiting on a reply to a command sent after it arrived — so
            // the match and everything before it leave the queue together.
            const take = () => {
                const i = inbox.findIndex((p) => cmds.includes(p.cmd));
                if (i < 0)
                    return null;
                const hit = inbox[i];
                inbox = inbox.slice(i + 1);
                return hit;
            };
            const ready = take();
            if (ready)
                return Promise.resolve(ready);
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    wake = null;
                    resolve(null);
                }, timeoutMs);
                wake = () => {
                    const hit = take();
                    if (!hit)
                        return;
                    clearTimeout(timer);
                    wake = null;
                    resolve(hit);
                };
            });
        },
        disconnect() {
            unwire();
            server.disconnect();
        }
    };
    // Each attempt gets the full packet timeout; the settle wait between them is
    // what actually buys the retry its second chance, so a mute printer costs
    // attempts * (timeout + settle) before it gives up.
    let last;
    for (let attempt = 0; attempt < Math.max(1, handshakeAttempts); attempt++) {
        if (attempt)
            await sleep(settleMs);
        try {
            await handshake(link);
            return link;
        }
        catch (err) {
            // Only silence is worth another go. A refusal or a firmware fault is
            // the printer's considered answer, and repeating the question three
            // times only makes the user wait for the same one.
            if (!(err instanceof NoReplyError)) {
                link.disconnect();
                throw err;
            }
            last = err;
        }
    }
    link.disconnect();
    throw last instanceof Error ? last : new Error('printer did not answer the handshake');
}
