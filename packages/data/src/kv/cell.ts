import {MsgpackCodec} from '../codec.js';
import {Context} from '../context.js';
import {pipe} from '../utils.js';
import {Transaction, Uint8Transaction, withValueCodec} from './kv-store.js';

const key = new Uint8Array();

export class Cell<T> {
    private readonly tx: Transaction<Uint8Array, {value: T}>;

    constructor(
        tx: Uint8Transaction,
        private readonly initialValue: T
    ) {
        this.tx = pipe(tx, withValueCodec(new MsgpackCodec()));
    }

    async get(ctx: Context): Promise<T> {
        const result = await this.tx.get(ctx, key);
        if (result) {
            return result.value;
        }
        await this.put(ctx, this.initialValue);
        return this.initialValue;
    }

    async put(ctx: Context, value: T): Promise<void> {
        await this.tx.put(ctx, key, {value});
    }
}
