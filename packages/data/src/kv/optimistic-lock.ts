import {StringCodec} from '../codec.js';
import {createUuid, encodeUuid} from '../uuid.js';
import type {Uint8Transaction} from './kv-store.js';

export class OptimisticLock {
    private readonly stringCodec = new StringCodec();

    constructor(private readonly tx: Uint8Transaction) {}

    async lock(key?: string | Uint8Array): Promise<void> {
        const keyBuf =
            key === undefined
                ? new Uint8Array()
                : typeof key === 'string'
                  ? this.stringCodec.encode(key)
                  : key;
        await this.tx.put(keyBuf, encodeUuid(createUuid()));
    }
}
