import { Cmd, encodePacket, u16 } from './protocol.js';
/** The B1's head: 384 dots at 203 dpi, which is 48 mm — not the 50 mm stock. */
export const B1_PRINTHEAD_PIXELS = 384;
export const B1_DPMM = 8;
/**
 * Rotate a raster 90° clockwise, so the source's left edge becomes the leading
 * edge of the print.
 */
function rotateCW(rows) {
    const h = rows.length;
    const w = h ? rows[0].length : 0;
    const out = [];
    for (let y = 0; y < w; y++) {
        const row = new Uint8Array(h);
        for (let x = 0; x < h; x++)
            row[x] = rows[h - 1 - x][y];
        out.push(row);
    }
    return out;
}
/**
 * Pack a row of dots into bits, most significant bit leftmost, padded out to a
 * whole number of bytes. `offset` is where dot 0 of the row lands on the head,
 * so the pad can be placed on either side of the image.
 */
function packRow(row, cols, offset) {
    const out = new Uint8Array(cols / 8);
    for (let x = 0; x < row.length; x++) {
        if (row[x]) {
            const at = x + offset;
            out[at >> 3] |= 0x80 >> (at & 7);
        }
    }
    return out;
}
/**
 * The three count bytes every row packet carries.
 *
 * When the row fits in three equal chunks of the head, each byte is that
 * chunk's black-dot count. When it does not, the same three bytes carry the
 * total instead, as `[0, low, high]`. The printer uses these to pace the head
 * current, so getting them wrong shows up as uneven burn, not as an error.
 */
export function countPixels(data, printheadPixels) {
    let total = 0;
    const parts = [0, 0, 0];
    const chunkSize = Math.floor(printheadPixels / 8 / 3);
    const split = chunkSize > 0 && data.length <= chunkSize * 3;
    for (let byteN = 0; byteN < data.length; byteN++) {
        const value = data[byteN];
        if (!value)
            continue;
        const chunk = split ? Math.floor(byteN / chunkSize) : -1;
        for (let bit = 0; bit < 8; bit++) {
            if (value & (1 << bit)) {
                total++;
                if (chunk >= 0 && chunk < 3)
                    parts[chunk]++;
            }
        }
    }
    if (split)
        return { total, parts };
    return { total, parts: [0, total & 0xff, (total >> 8) & 0xff] };
}
/**
 * Bit positions of the set dots, each as a big-endian u16. Only used for rows
 * with six or fewer dots, where naming the dots is smaller than sending the
 * whole row.
 */
export function indexPixels(data) {
    const out = [];
    for (let byteN = 0; byteN < data.length; byteN++) {
        const b = data[byteN];
        if (!b)
            continue;
        for (let bit = 0; bit < 8; bit++) {
            if (b & (0x80 >> bit))
                out.push(...u16(byteN * 8 + bit));
        }
    }
    return out;
}
/** A row packet's repeat count is one byte, so a longer run is split. */
const MAX_REPEAT = 255;
/**
 * Rows with this many dots or fewer are sent as a list of dot positions
 * instead of a bitmap. Above it the bitmap is smaller.
 */
const INDEX_THRESHOLD = 6;
/**
 * Encode a raster into the packets that draw one page.
 *
 * Identical consecutive rows collapse into a single packet with a repeat
 * count, and blank rows become a position-and-count with no data at all —
 * which is what keeps a mostly-empty label from spending 240 packets saying
 * nothing.
 *
 * Check-line packets are deliberately not emitted: the B1's print task does
 * not enable them, and sending them to a printer that is not expecting them
 * draws a reply mid-raster that nothing is waiting for.
 */
export function buildPage(rows, options = {}) {
    const { direction = 'top', printheadPixels = B1_PRINTHEAD_PIXELS, align = 'left' } = options;
    if (!rows.length)
        throw new Error('raster has no rows');
    for (const [i, row] of rows.entries()) {
        if (row.length !== rows[0].length) {
            throw new Error(`raster row ${i} is ${row.length} px, expected ${rows[0].length}`);
        }
    }
    const oriented = direction === 'left' ? rotateCW(rows) : rows;
    const across = oriented[0].length;
    // The head cannot be told to print wider than it is: the printer would read
    // the overhang as the start of the next row and walk the rest of the page
    // out of alignment. Fail here rather than emit that.
    if (across > printheadPixels) {
        throw new Error(`raster is ${across} dots across the head, which is ${printheadPixels} dots wide` +
            (direction === 'top' ? ' — try printDirection "left"' : ''));
    }
    // Aligning anywhere but left means describing the page as the full head:
    // the slack has to be inside the row for the printer to put dots past it.
    const cols = align === 'left' ? Math.ceil(across / 8) * 8 : Math.ceil(printheadPixels / 8) * 8;
    const slack = cols - across;
    const offset = align === 'center' ? slack >> 1 : align === 'right' ? slack : 0;
    const parts = [];
    const emit = (cmd, data) => parts.push(encodePacket(cmd, data));
    /** Flush one run of identical rows, splitting it across the repeat cap. */
    const flush = (start, count, packed, blank) => {
        for (let done = 0; done < count; done += MAX_REPEAT) {
            const pos = start + done;
            const repeat = Math.min(MAX_REPEAT, count - done);
            if (blank) {
                emit(Cmd.PrintEmptyRow, [...u16(pos), repeat]);
                continue;
            }
            const counts = countPixels(packed, printheadPixels);
            if (counts.total <= INDEX_THRESHOLD) {
                emit(Cmd.PrintBitmapRowIndexed, [
                    ...u16(pos),
                    ...counts.parts,
                    repeat,
                    ...indexPixels(packed)
                ]);
            }
            else {
                emit(Cmd.PrintBitmapRow, [...u16(pos), ...counts.parts, repeat, ...packed]);
            }
        }
    };
    let runStart = 0;
    let runCount = 0;
    let runPacked = null;
    let runBlank = false;
    const same = (a, b) => a.every((v, i) => v === b[i]);
    for (const [y, row] of oriented.entries()) {
        const packed = packRow(row, cols, offset);
        const blank = packed.every((b) => b === 0);
        if (runPacked && blank === runBlank && (blank || same(packed, runPacked))) {
            runCount++;
            continue;
        }
        if (runPacked)
            flush(runStart, runCount, runPacked, runBlank);
        runStart = y;
        runCount = 1;
        runPacked = packed;
        runBlank = blank;
    }
    if (runPacked)
        flush(runStart, runCount, runPacked, runBlank);
    const size = parts.reduce((n, p) => n + p.length, 0);
    const data = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
        data.set(p, o);
        o += p.length;
    }
    return { cols, rows: oriented.length, data };
}
