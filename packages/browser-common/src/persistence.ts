/**
 * Key-value store for small extension state. Implementations backed by
 * synchronous persistence may return immediately, while asynchronous stores
 * (for example IndexedDB) may return promises. Consumers can await either.
 *
 * Keys map to the host client's persistence keys. Values must be
 * JSON-serializable.
 */
export interface KeyValueStore {
    /**
     * Read a value by key.
     *
     * @returns The stored value, or `undefined` when the key is missing.
     */
    get<T = unknown>(key: string): T | undefined | Promise<T | undefined>
    /** Store a JSON-serializable value by key. */
    set(key: string, value: unknown): void | Promise<void>
    /** Remove a value by key. */
    remove(key: string): void | Promise<void>
}
