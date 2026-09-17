// Ordering logic for one turn's audio chunks, kept free of Web Audio so it can be unit tested.
// Chunks may arrive out of order; each is held until its predecessor has been taken. A chunk
// with empty text and no audio is a terminal marker: nothing to play, but it still closes the turn.

export interface QueuedChunk<B> {
  seq: number
  text: string
  last: boolean
  buffer: B | null
}

export class ChunkQueue<B = unknown> {
  private items = new Map<number, QueuedChunk<B>>()
  private expected = 0
  private lastSeq: number | null = null
  private cancelledFlag = false

  push(chunk: QueuedChunk<B>): void {
    if (this.cancelledFlag) return
    if (chunk.last) this.lastSeq = chunk.seq
    this.items.set(chunk.seq, chunk)
  }

  /** The next chunk in sequence, or undefined while its predecessor is still missing. */
  take(): QueuedChunk<B> | undefined {
    if (this.cancelledFlag) return undefined
    const item = this.items.get(this.expected)
    if (!item) return undefined
    this.items.delete(this.expected)
    this.expected += 1
    return item
  }

  isLast(seq: number): boolean {
    return this.lastSeq !== null && seq === this.lastSeq
  }

  cancel(): void {
    this.cancelledFlag = true
    this.items.clear()
  }

  get cancelled(): boolean {
    return this.cancelledFlag
  }

  get nextSeq(): number {
    return this.expected
  }

  get pending(): number {
    return this.items.size
  }

  get finalSeq(): number | null {
    return this.lastSeq
  }
}

export function isTerminalMarker(chunk: { text: string; buffer: unknown | null }): boolean {
  return chunk.text === '' && chunk.buffer === null
}
